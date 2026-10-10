import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_VERSION,
  type AccessTokenClaims,
  type AuthenticationMethod,
  CUSTOM_CLAIMS_CLAIM,
  durationToMs,
  environmentIssuer,
  jwtTemplateOfProfile,
  MAX_ACCESS_TOKEN_TTL,
  type NamedJwtTemplate,
  type NamedSessionProfile,
  profileOfSession,
  REFRESH_TOKEN_PREFIX,
  resolveSessionProfile,
  type Session,
  type SessionClient,
  type SessionProfile,
  type SessionSettings,
  type SessionTokens,
} from '@tula/contract'
import { SignJWT } from 'jose'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InternalError, NotFoundError, ServiceUnavailableError } from '~/exceptions'
import { type Actor, cleanOrigin, type Origin, systemActor } from '~/lib/actor'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Hooks from '~/modules/hook/service'
import * as Jwks from '~/modules/jwks/service'
import * as CustomClaims from '~/modules/session/custom-claims'
import * as DeviceBinding from '~/modules/session/device-binding'
import * as Settings from '~/modules/settings/service'
import {
  authenticatedAt,
  beganBefore,
  isActive,
  mergeAuthMethods,
  type RefreshTokenRecord,
  type SessionRecord,
  type SessionRevokeReason,
} from '~/ports/session-store'
import type { UserRecord } from '~/ports/user-repository'

/** Keyed-hash purpose for deriving refresh tokens. */
export const KEYED_HASH_PURPOSE = 'refresh-tokens'
/**
 * Prefix of a `stateful` session's token: the value of its cookie. Never a refresh token: the
 * two are derived apart and each is refused where the other is expected.
 */
export const SESSION_TOKEN_PREFIX = 'tula_st_'
/**
 * How long a session cookie is kept by a browser when its profile has no absolute timeout: the
 * most browsers allow (400 days). The server's own timeouts are what end the session.
 */
export const MAX_COOKIE_AGE_SECONDS = 400 * 86_400
/**
 * How many times a sign-in at the session limit re-reads the user's sessions when another
 * sign-in of the same user got in between (`end_oldest`). Each pass needs to lose a race.
 */
const LIMIT_ATTEMPTS = 4
/**
 * How many times a step-up asks the claims hook again because the session's methods moved
 * while the hook was answering (another step-up of the same session). Each pass needs to lose
 * a race.
 */
const STEP_UP_ATTEMPTS = 3
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
type ProfileDeps = Pick<Deps, 'environmentSettings' | 'config'>
/** What asking the claims hook needs (`Hooks.beforeToken`). */
type HookDeps = Pick<Deps, 'hooks' | 'rateLimiter' | 'outbound' | 'secretBox' | 'ids' | 'clock'>
type SessionDeps = TokenDeps &
  ProfileDeps &
  Pick<Deps, 'sessions' | 'revokedSessions' | 'keyedHash' | 'users'>
/** What checking a bound session's proof needs (`DeviceBinding.atRefresh`). */
type ProofDeps = Pick<Deps, 'proofReplay' | 'rateLimiter'>

/**
 * What the service hands a router when a session is created, refreshed or stepped up.
 *
 * A `hybrid` session carries `accessToken` and (from create and refresh) `refreshToken`. A
 * `stateful` one carries neither; from create it carries `sessionToken`, which the router puts
 * in the session cookie and **never** in a body.
 */
export interface IssuedSession extends SessionTokens {
  /** A new `stateful` session's token: the cookie's value. */
  sessionToken?: string
  /** How long the browser should keep the session's cookie, in seconds. */
  cookieMaxAge?: number
  /**
   * For a device-bound session (ADR 0043): the server's nonce for the client's next proof.
   * The router sends it in the `DPoP-Nonce` header, **never** in a body.
   */
  proofNonce?: string
}

/**
 * The profile whose limits apply to a session now: the one it names as the environment has it
 * configured at this moment, or the built-in for its client kind when that profile is gone
 * (ADR 0028).
 *
 * @param deps - Settings store and config.
 * @param scope - The environment.
 * @param session - The session's stored profile name and client kind.
 * @returns The profile and its name.
 */
export async function profileOf(
  deps: ProfileDeps,
  scope: Pick<Tenant, 'environmentId'>,
  session: Pick<SessionRecord, 'profile' | 'client'>
): Promise<NamedSessionProfile> {
  return profileOfSession((await Settings.current(deps, scope)).sessions, session)
}

/**
 * Refuse a sign-in that its profile's device-binding option does not allow, **as the
 * environment is configured now** (ADR 0043): the check `create` makes, for a caller that
 * must make it before anything is spent. The flow service's `finish` calls it before it moves
 * the attempt to `complete` and before a hook is asked, so that an attempt started before
 * the option was changed is refused with its attempt still on its step, no hook asked and no
 * session made.
 *
 * @param deps - Settings store and config.
 * @param scope - The environment.
 * @param input - The client kind, the profile the client asked for, and the key the
 *   attempt's start accepted a proof for, if any.
 * @throws AuthError `device.binding_not_supported` or `device.binding_required`.
 */
export async function requireBinding(
  deps: ProfileDeps,
  scope: Pick<Tenant, 'environmentId'>,
  input: { client: SessionClient; profile?: string | null; deviceThumbprint?: string | null }
): Promise<void> {
  const { sessions } = await Settings.current(deps, scope)
  const { profile } = resolveSessionProfile(sessions, {
    client: input.client,
    requested: input.profile,
  })
  DeviceBinding.hold(profile, input.client, (input.deviceThumbprint ?? null) !== null)
}

/**
 * The name of the profile a new session of this client would get **as the environment is
 * configured now**: the same rule {@link create} applies (`resolveSessionProfile`). It chooses
 * nothing: `create` resolves the profile again when it stores the session. For a caller that
 * must name the profile before the session exists (the `before_session` hook's question).
 *
 * @param deps - Settings store and config.
 * @param scope - The environment.
 * @param input - The client kind and the profile the client asked for, if any.
 * @returns The profile's name.
 */
export async function profileNameFor(
  deps: ProfileDeps,
  scope: Pick<Tenant, 'environmentId'>,
  input: { client: SessionClient; profile?: string | null }
): Promise<string> {
  const { sessions } = await Settings.current(deps, scope)
  return resolveSessionProfile(sessions, { client: input.client, requested: input.profile }).name
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

/**
 * The token of a `stateful` session, derived like a refresh token but from a message no
 * refresh token uses, so the two can never be equal. Only its SHA-256 is stored.
 */
async function deriveSessionToken(
  deps: Pick<Deps, 'keyedHash'>,
  sessionId: string
): Promise<string> {
  const mac = await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, `stateful:${sessionId}`)
  return `${SESSION_TOKEN_PREFIX}${mac}`
}

type ClaimSource = Pick<
  SessionRecord,
  | 'id'
  | 'userId'
  | 'profile'
  | 'client'
  | 'factorVerifiedAt'
  | 'authMethods'
  | 'createdAt'
  | 'deviceThumbprint'
>

/** A session's profile as configured now, with the settings it was read from. */
interface Configured extends NamedSessionProfile {
  settings: SessionSettings
}

async function configured(
  deps: ProfileDeps,
  scope: Pick<Tenant, 'environmentId'>,
  session: Pick<SessionRecord, 'profile' | 'client'>
): Promise<Configured> {
  const { sessions: settings } = await Settings.current(deps, scope)
  return { ...profileOfSession(settings, session), settings }
}

/**
 * What a template's sources are read from, for one session. The user is read only when the
 * template has a `user.*` source and the caller does not already hold the user (`known`: a
 * refresh has loaded it to check for a ban).
 */
async function claimFacts(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  template: NamedJwtTemplate | null,
  session: Pick<SessionRecord, 'userId' | 'client' | 'createdAt'>,
  known?: UserRecord | null
): Promise<CustomClaims.ClaimFacts> {
  let user = known ?? null
  if (known === undefined && CustomClaims.needsUser(template)) {
    // In the session's own environment only: another environment's user is nobody here.
    user = await deps.users.findById(scope.environmentId, session.userId)
  }
  return { user, session, environmentId: scope.environmentId }
}

/**
 * The custom claims of a session now, from its two sources:
 *
 * - what the JWT template of its profile says, as the environment has it configured at this
 *   moment (ADR 0036). Read at every issue, never stored on the session, so a changed
 *   template or a newly verified address shows up at the next token;
 * - what its `before_token` hook said when the session was created or last stepped up
 *   (ADR 0035), **read from the session's row and judged again** (`CustomClaims.stored`).
 *   The hook is never asked here: this runs on every refresh and every stateful check.
 *
 * @returns The claims for the namespace claim, or `undefined` for none.
 */
async function customClaims(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  { settings, profile }: Pick<Configured, 'settings' | 'profile'>,
  session: Pick<SessionRecord, 'id' | 'userId' | 'client' | 'createdAt' | 'hookClaims'>,
  known?: UserRecord | null
): Promise<CustomClaims.Claims | undefined> {
  const template = jwtTemplateOfProfile(settings, profile)
  const hook = CustomClaims.stored(session.hookClaims, {
    environmentId: scope.environmentId,
    sessionId: session.id,
  })
  if (!template && !hook) {
    return undefined
  }
  const facts = await claimFacts(deps, scope, template, session, known)
  return CustomClaims.build(template, facts, hook ? [hook] : [])
}

/** What asking the claims hook for a session gave: its answer, and the claims of a token. */
interface ProvenClaims {
  /** What the hook said: stored on the session's row. */
  hook: Hooks.TokenClaims
  /** The template's claims with the hook's over them, when a token is to be signed. */
  custom: CustomClaims.Claims | undefined
}

/**
 * Ask the environment's `before_token` hook for the claims of a session that has just proven
 * something: **the only place it is asked** (ADR 0035), called when a session is created and
 * when its user proves a factor again, before anything is written.
 *
 * The hook's claims must fit beside the template's as it is configured now: the size cap is
 * on the two merged, and claims that do not fit are a failed call, never stored and never
 * cut. The question names the user, the session, the client kind, the profile and what the
 * session has proven, and nothing else the service has at hand (no address, no user agent).
 *
 * @param signs - Whether a token is signed now (`hybrid`): only then are the merged claims
 *   computed here. A `stateful` session's are read when it is checked.
 * @throws AuthError `hook.unavailable` when the call failed and the hook refuses on failure.
 */
async function claimsAtProof(
  deps: HookDeps & Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  { settings, profile }: Pick<Configured, 'settings' | 'profile'>,
  session: Pick<
    SessionRecord,
    'id' | 'userId' | 'client' | 'createdAt' | 'profile' | 'authMethods'
  >,
  signs: boolean
): Promise<ProvenClaims> {
  const template = jwtTemplateOfProfile(settings, profile)
  let read: Promise<CustomClaims.ClaimFacts> | undefined
  // At most one read of the user, and none unless a token or a hook's answer needs it.
  const facts = () => {
    read ??= claimFacts(deps, scope, template, session)
    return read
  }
  const hook = await Hooks.beforeToken(
    deps,
    scope,
    {
      userId: session.userId,
      sessionId: session.id,
      client: session.client,
      profile: session.profile,
      amr: session.authMethods,
    },
    async (claims) => CustomClaims.fits(template, await facts(), claims)
  )
  if (!signs || (!template && !hook.claims)) {
    return { hook, custom: undefined }
  }
  return {
    hook,
    custom: CustomClaims.build(template, await facts(), hook.claims ? [hook.claims] : []),
  }
}

/**
 * The claims of a session at `now`, for a token that lives as long as its profile says: what
 * an access token carries, and what a `stateful` session's check answers with.
 */
function claimsOf(
  deps: Pick<Deps, 'config'>,
  scope: Scope,
  session: ClaimSource,
  profile: SessionProfile,
  now: Date,
  custom: CustomClaims.Claims | undefined
): AccessTokenClaims {
  const iat = Math.floor(now.getTime() / 1000)
  return {
    iss: environmentIssuer(deps.config.publicUrl, scope.environmentId),
    sub: session.userId,
    aud: scope.environmentId,
    sid: session.id,
    pid: scope.projectId,
    eid: scope.environmentId,
    iat,
    exp: iat + durationToMs(profile.accessTokenTtl) / 1000,
    v: ACCESS_TOKEN_VERSION,
    // From the session row, never from "now": a refresh must not make an old sign-in look
    // recent (ADR 0025).
    auth_time: Math.floor(authenticatedAt(session).getTime() / 1000),
    amr: session.authMethods,
    sp: session.profile,
    // Only for a session bound to a device key (ADR 0043): absent, never `null`, so that the
    // token of a session that is not bound is what it always was.
    ...(session.deviceThumbprint && { cnf: { jkt: session.deviceThumbprint } }),
    // Absent, never empty: a session without custom claims is what it always was.
    ...(custom && { [CUSTOM_CLAIMS_CLAIM]: custom }),
  }
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
  session: ClaimSource,
  profile: SessionProfile,
  now: Date,
  { kid, privateKey }: SigningKey,
  custom: CustomClaims.Claims | undefined
): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const { iss, sub, aud, iat, exp, ...claims } = claimsOf(
    deps,
    scope,
    session,
    profile,
    now,
    custom
  )
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid, typ: 'JWT' })
    .setIssuer(iss)
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { accessToken, accessTokenExpiresAt: new Date(exp * 1000).toISOString() }
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
  const target = { type: 'session', id: session.id } as const
  // Two calls, not one with a computed type: each type's `reason` is checked against its own
  // event schema.
  return reason === 'reuse_detected'
    ? Audit.entry(deps, scope, {
        type: 'session.reuse_detected',
        actor,
        target,
        data: { userId: session.userId, reason },
      })
    : Audit.entry(deps, scope, {
        type: 'session.revoked',
        actor,
        target,
        data: { userId: session.userId, reason },
      })
}

/** `now + the profile's idle timeout`, never past the session's absolute limit. */
function idleExpiry(profile: SessionProfile, now: Date, absoluteExpiresAt: Date | null): Date {
  const idle = now.getTime() + durationToMs(profile.idleTimeout)
  return new Date(absoluteExpiresAt ? Math.min(idle, absoluteExpiresAt.getTime()) : idle)
}

/**
 * When a session ends under its profile **as configured now**: the earlier of what was stored
 * when it was created or last active and what the profile says today.
 *
 * Tightening a profile therefore reaches sessions that already exist, at their next refresh or
 * request. Loosening one does not move the absolute limit a session was created with (the
 * stored value still caps it); a longer idle timeout applies from the next activity on.
 */
function limitsNow(
  profile: SessionProfile,
  session: Pick<SessionRecord, 'createdAt' | 'lastActiveAt' | 'idleExpiresAt' | 'absoluteExpiresAt'>
): { idleExpiresAt: Date; absoluteExpiresAt: Date | null } {
  const earliest = (...times: (number | null)[]) =>
    Math.min(...times.filter((time) => time !== null))
  const configured = profile.absoluteTimeout
    ? session.createdAt.getTime() + durationToMs(profile.absoluteTimeout)
    : null
  const stored = session.absoluteExpiresAt?.getTime() ?? null
  const absolute = configured === null && stored === null ? null : earliest(configured, stored)
  const idle = earliest(
    session.idleExpiresAt.getTime(),
    session.lastActiveAt.getTime() + durationToMs(profile.idleTimeout),
    absolute
  )
  return {
    idleExpiresAt: new Date(idle),
    absoluteExpiresAt: absolute === null ? null : new Date(absolute),
  }
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
  // The longest any profile may let an access token live, not the session's own profile: the
  // profile may have been shortened since the token was signed.
  const until = new Date(now.getTime() + durationToMs(MAX_ACCESS_TOKEN_TTL))
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
  /**
   * The profile the client asked for (`x-tula-session-profile`), if any. Honoured only when
   * the environment marks it `clientSelectable`; anything else gets the client kind's built-in.
   */
  profile?: string | null
  /**
   * The sign-in's `before_session` hook failed and lets through on failure
   * (`Hooks.beforeSession` answered `'bypassed'`): recorded on `session.created`.
   */
  hookBypassed?: boolean
  /**
   * The thumbprint of the key the session is bound to (ADR 0043): what the attempt's start
   * accepted a proof for. `null` or absent for a session that is not bound.
   */
  deviceThumbprint?: string | null
}

/**
 * Start a session for a user who has just proven who they are, and issue its first tokens.
 *
 * The session's profile is chosen here ({@link resolveSessionProfile}): by client kind, or the
 * one the client asked for when the environment offers it. A `hybrid` session gets an access
 * token and a refresh token (always returned; the router decides whether a client receives it
 * in the body or as an httpOnly cookie). A `stateful` session gets a session token only, which
 * the router puts in a cookie.
 *
 * **The concurrent-session rule is enforced here** (`sessions.maxPerUser`), atomically: the
 * store ends the sessions named to it, counts and inserts in one step that sign-ins of one
 * user take in turn, so simultaneous sign-ins can never leave a user over the limit. With
 * `end_oldest` the user's oldest sessions (by sign-in time) are ended for the new one, each
 * put on the revoked-session list **before** the store ends it; with `refuse_newest` nothing
 * is created.
 *
 * **The environment's `before_token` hook is asked here** (ADR 0035), once, after the signing
 * key is loaded and before anything is stored: its claims go on the session's row in the
 * same insert and into the first token. A failed call refuses the session unless the hook
 * lets through on failure, and then `session.created` says `claimsHookBypassed`. The hook is
 * asked before the concurrent-session rule is applied, so it can be asked about a session
 * that `refuse_newest` then refuses.
 *
 * @param deps - Session store, settings, keyed hash, signing keys, the hook store, the
 *   limiter, the outbound guard's settings, clock and ids.
 * @param scope - The project and environment.
 * @param input - The user, the device and the profile asked for.
 * @returns The session id and its tokens.
 * @throws AuthError `session.limit_reached` when the user is at the limit and the environment
 *   refuses the newest.
 * **A session is bound to a device key here and nowhere else** (ADR 0043): given a
 * thumbprint, it is stored with the session in the same insert, the first access token
 * carries it as `cnf.jkt`, and `session.created` says `deviceBound`. Only a `hybrid` session
 * of a client that is not a browser can be bound: for any other the call is refused before
 * anything is stored, never answered with a session that is silently not bound.
 *
 * @throws AuthError `hook.unavailable` when the claims hook failed and refuses on failure.
 * @throws AuthError `device.binding_not_supported` when a key is given for a browser's
 *   session, a `stateful` profile or a profile whose `deviceBinding` is `none`.
 * @throws AuthError `device.binding_required` when no key is given for a session of a client
 *   that is not a browser whose profile's `deviceBinding` is `required`.
 * @throws RateLimitError when the environment's calls of its claims hook are over their ceiling.
 * @throws ServiceUnavailableError when sign-ins of the same user kept getting in between.
 */
export async function create(
  deps: SessionDeps & HookDeps,
  scope: Scope,
  input: CreateInput
): Promise<IssuedSession> {
  const now = deps.clock.now()
  const { sessions: settings } = await Settings.current(deps, scope)
  const { name, profile } = resolveSessionProfile(settings, {
    client: input.client,
    requested: input.profile,
  })
  const absoluteExpiresAt = profile.absoluteTimeout
    ? new Date(now.getTime() + durationToMs(profile.absoluteTimeout))
    : null
  const idleExpiresAt = idleExpiry(profile, now, absoluteExpiresAt)
  const sessionId = deps.ids.next()
  const stateful = profile.type === 'stateful'
  const deviceThumbprint = input.deviceThumbprint ?? null
  // The start already applied the profile's option, and `finish` again. This holds the rule
  // where the session is made, whatever a caller passes and whatever the settings became
  // since: before the hook is asked and before anything is stored.
  DeviceBinding.hold(profile, input.client, deviceThumbprint !== null)
  const token = stateful
    ? await deriveSessionToken(deps, sessionId)
    : await deriveToken(deps, { sessionId })
  const origin = cleanOrigin(input)
  // A stateful session signs nothing, so it does not depend on the signing keys.
  const signingKey = stateful ? null : await Jwks.activeSigningKey(deps, scope.environmentId)
  const authMethods = mergeAuthMethods([], input.authMethods ?? [])
  // Like the key, read and asked before the session is stored: a failed read, or a claims
  // hook that refuses, must not leave a session the client was never given. A stateful
  // session's token claims are read when it is checked; its hook is asked now all the same.
  const { hook, custom } = await claimsAtProof(
    deps,
    scope,
    { settings, profile },
    {
      id: sessionId,
      userId: input.userId,
      client: input.client,
      createdAt: now,
      profile: name,
      authMethods,
    },
    !stateful
  )
  const session = {
    id: sessionId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    userId: input.userId,
    profile: name,
    type: profile.type,
    client: input.client,
    ...origin,
    lastActiveAt: now,
    idleExpiresAt,
    absoluteExpiresAt,
    // A session begins with a sign-in: that is its first proof.
    factorVerifiedAt: now,
    authMethods,
    hookClaims: hook.claims,
    deviceThumbprint,
    createdAt: now,
  }
  const root = {
    id: deps.ids.next(),
    sessionId,
    tokenHash: sha256Hex(token),
    parentId: null,
    expiresAt: idleExpiresAt,
    createdAt: now,
  }
  const activity = Audit.entry(deps, scope, {
    type: 'session.created',
    actor: { type: 'user', id: input.userId, ...origin },
    target: { type: 'session', id: sessionId },
    data: {
      userId: input.userId,
      client: input.client,
      // Present only when true: a session whose hooks answered is recorded as it always was.
      ...(input.hookBypassed && { hookBypassed: true }),
      ...(hook.bypassed && { claimsHookBypassed: true }),
      // A boolean and nothing of the key: not its thumbprint, not a part of it.
      ...(deviceThumbprint !== null && { deviceBound: true }),
    },
  })

  if (settings.maxPerUser === null) {
    await deps.sessions.create(session, root, activity)
  } else {
    await createWithinLimit(deps, scope, { session, root, activity, origin, now }, settings)
  }

  const cookieMaxAge = absoluteExpiresAt
    ? Math.ceil((absoluteExpiresAt.getTime() - now.getTime()) / 1000)
    : MAX_COOKIE_AGE_SECONDS
  if (!signingKey) {
    return { sessionId, sessionToken: token, cookieMaxAge }
  }
  const access = await signAccessToken(deps, scope, session, profile, now, signingKey, custom)
  return {
    sessionId,
    ...access,
    refreshToken: token,
    cookieMaxAge: durationToMs(profile.idleTimeout) / 1000,
    ...(deviceThumbprint !== null && { proofNonce: await DeviceBinding.nonce(deps, scope) }),
  }
}

/** A session about to be stored, with what is recorded about it. */
interface Pending {
  session: Parameters<Deps['sessions']['create']>[0]
  root: Parameters<Deps['sessions']['create']>[1]
  activity: Parameters<Deps['sessions']['create']>[2]
  origin: Partial<Origin>
  now: Date
}

/**
 * Store a session under the environment's concurrent-session rule.
 *
 * The store decides (it is the only place that can, atomically); this function names the
 * sessions to end. They are the user's oldest by sign-in time, read just before, and each is
 * put on the revoked-session list before the store is asked to end it, as every revocation is.
 * When another sign-in of the same user got in between, the store writes nothing and the list
 * is read again: the sessions already denylisted are still the oldest, so they are named again.
 * When every pass loses, the sessions this call denylisted are ended before it gives up, so a
 * session is never left denylisted but not revoked.
 */
async function createWithinLimit(
  deps: Pick<Deps, 'sessions' | 'revokedSessions' | 'ids' | 'clock'>,
  scope: Scope,
  pending: Pending,
  rule: { maxPerUser: number | null; onLimit: 'end_oldest' | 'refuse_newest' }
): Promise<void> {
  const { session, root, activity, origin, now } = pending
  const max = rule.maxPerUser ?? Number.POSITIVE_INFINITY
  const ended = (id: string) =>
    // The system ends them: the rule did, on behalf of nobody in particular. The origin of
    // the sign-in that took the place is kept.
    revoked(deps, scope, { id, userId: session.userId }, 'session_limit', systemActor(origin))
  const denylisted = new Set<string>()
  for (let pass = 0; pass < LIMIT_ATTEMPTS; pass++) {
    const active = await deps.sessions.listActiveByUser(scope.environmentId, session.userId, now)
    const excess = active.length - max + 1
    if (excess > 0 && rule.onLimit === 'refuse_newest') {
      throw new AuthError('session.limit_reached')
    }
    const end = [...active]
      .sort((x, y) => (beganBefore(x, y) ? -1 : 1))
      .slice(0, Math.max(excess, 0))
      .map((oldest) => oldest.id)
    await denylist(deps, end, now)
    for (const id of end) {
      denylisted.add(id)
    }
    const result = await deps.sessions.create(session, root, activity, {
      max,
      end,
      at: now,
      activity: ended,
    })
    if (result.created) {
      return
    }
    if (rule.onLimit === 'refuse_newest') {
      throw new AuthError('session.limit_reached')
    }
  }
  // Giving up must not leave a session on the denylist that the store never ended: it would
  // be refused for as long as the entry lasts and then be alive again. Ending them is what
  // the rule asks for in any case: each was among the oldest of a user at the limit, and the
  // store only refuses when the user is still full without them. One that the sign-in which
  // won the race already ended is left as it is (the store's revoke writes nothing then).
  for (const id of denylisted) {
    await deps.sessions.revoke(scope.environmentId, id, 'session_limit', now, ended(id))
  }
  throw new ServiceUnavailableError({
    internalMessage: 'sign-ins of one user kept racing at the session limit',
  })
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
 * **The environment's `before_token` hook is asked again here** (ADR 0035): what a session
 * has proven is the one thing its question names that can change, so its claims are what the
 * hook says about the session as it is now. The stored claims are **replaced**, never merged
 * and never kept: by the hook's answer, or by none when there is no hook any more, it is
 * off, or it failed and lets through on failure (`claimsHookBypassed` on
 * `session.stepped_up`). A failed call of a hook that refuses on failure refuses the step-up,
 * and then nothing about the session has changed. Claims are stored only for the methods
 * they were asked about: when another step-up of the same session got in between, the hook
 * is asked again.
 *
 * @param deps - Session store, signing keys, the hook store, the limiter, the outbound
 *   guard's settings, clock and ids.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param methods - What was just proven, e.g. `['otp', 'mfa']`.
 * @param actor - The user, for the audit log.
 * @returns The session id and a fresh access token (none for a `stateful` session, whose next
 *   request reads the row). No refresh token.
 * @throws AuthError `session.revoked` when the session has ended or is not this user's.
 * @throws AuthError `hook.unavailable` when the claims hook failed and refuses on failure.
 * @throws RateLimitError when the environment's calls of its claims hook are over their ceiling.
 * @throws ServiceUnavailableError when step-ups of the same session kept getting in between.
 */
export async function recordAuthentication(
  deps: TokenDeps & ProfileDeps & HookDeps & Pick<Deps, 'sessions' | 'users'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  methods: readonly AuthenticationMethod[],
  actor: Actor
): Promise<SessionTokens> {
  for (let pass = 0; pass < STEP_UP_ATTEMPTS; pass++) {
    const now = deps.clock.now()
    const current = await deps.sessions.findById(scope.environmentId, self.sessionId)
    // Judged before the hook is asked: a session that has ended, or is someone else's, is
    // asked about by nobody.
    if (!current || current.userId !== self.userId || !isActive(current, now)) {
      throw new AuthError('session.revoked')
    }
    // Loaded before the write, like every signing key (see `signAccessToken`); a stateful
    // session signs nothing.
    const signingKey =
      current.type === 'stateful' ? null : await Jwks.activeSigningKey(deps, scope.environmentId)
    // Also before the write: what it reads (the profile, the user) the write does not change.
    const issue = await configured(deps, scope, current)
    const proven = { ...current, authMethods: mergeAuthMethods(current.authMethods, methods) }
    const { hook, custom } = await claimsAtProof(deps, scope, issue, proven, signingKey !== null)
    const session = await deps.sessions.recordAuthentication(
      scope.environmentId,
      self.sessionId,
      {
        at: now,
        methods,
        hookClaims: {
          claims: hook.claims,
          // An answer is about the methods it was asked about, and is stored for no others.
          ...(hook.asked && { ifAuthMethods: current.authMethods }),
        },
      },
      Audit.entry(deps, scope, {
        type: 'session.stepped_up',
        actor,
        target: { type: 'session', id: self.sessionId },
        data: {
          userId: self.userId,
          methods: [...methods],
          ...(hook.bypassed && { claimsHookBypassed: true }),
        },
      })
    )
    if (session) {
      if (!signingKey) {
        // The next request reads `auth_time`, `amr` and the claims from the row just updated.
        return { sessionId: session.id }
      }
      const access = await signAccessToken(
        deps,
        scope,
        session,
        issue.profile,
        now,
        signingKey,
        custom
      )
      return { sessionId: session.id, ...access }
    }
    if (!hook.asked) {
      // Nothing was compared: the session ended between the read and the write.
      throw new AuthError('session.revoked')
    }
    // It ended, or its methods moved while the hook was answering: read it again.
  }
  throw new ServiceUnavailableError({
    internalMessage: 'step-ups of one session kept racing the claims hook',
  })
}

/**
 * Refuse a session that has ended, with the error the client should see: revoked, or past its
 * idle or absolute limit under its profile as configured now ({@link limitsNow}).
 *
 * A session revoked for reuse keeps answering `session.reuse_detected`, so the legitimate
 * holder of the newest token learns why they were signed out.
 */
function rejectEnded(session: SessionRecord, profile: SessionProfile, now: Date): void {
  if (session.revokedAt !== null) {
    throw new AuthError(
      session.revokeReason === 'reuse_detected' ? 'session.reuse_detected' : 'session.revoked'
    )
  }
  // Under the profile as it is configured now, not only as it was when the row was written.
  if (!isActive({ ...session, ...limitsNow(profile, session) }, now)) {
    throw new AuthError('session.expired')
  }
}

/**
 * End the session of a user who has been banned since it was issued, and return the user.
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
): Promise<UserRecord | null> {
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
  // Handed back so that a template's `user.*` claims cost a refresh no second read.
  return user
}

/**
 * Exchange a refresh token for a new access token and the next refresh token.
 *
 * Refresh tokens are single-use. Presenting one that was already rotated revokes the whole
 * session (`session.reuse_detected`): either the token was stolen or the client is broken, and
 * we cannot tell which. The **only** exception is the `reuseGracePeriod` of the session's
 * profile (none at all when the profile sets `null`): inside it,
 * and only while the child has not itself been rotated, the caller gets the *same* child token
 * again (re-derived, never newly minted) with a fresh access token. That makes racing tabs and
 * retried requests idempotent.
 *
 * Rotation is one guarded transaction, so of several concurrent refreshes exactly one rotates
 * and the others take the grace path.
 *
 * **A session bound to a device key needs a proof of that key** (ADR 0043), and the order is
 * fixed: the token is found, the session is seen to be alive, and then the proof is judged,
 * **before** a ban is acted on, before reuse is judged and before anything is rotated. A
 * refresh refused for its proof therefore changes nothing: the presented token is neither
 * used nor replaced, the session lives on, and a token that had already been rotated revokes
 * nothing, inside the grace window and outside it. With a valid proof everything is as for
 * any session, reuse detection included: a rotated token replayed with a valid proof still
 * ends the session, because then it was the device that replayed it. The proof is judged
 * once per call, never again on the second pass of a lost rotation (its id is spent by then).
 * A session that is not bound ignores a proof and behaves as it always did.
 *
 * @param deps - Session store, keyed hash, signing keys, clock and ids; for a bound session
 *   also the store of used proof ids and the limiter.
 * @param scope - The environment the request resolved to.
 * @param refreshToken - The token the client presented.
 * @param origin - Where the request came from, recorded if the session has to be revoked.
 * @param proof - The request's device-binding proof and what it must be for. Left out, a
 *   bound session's refresh is refused as one with no proof.
 * @returns The session id, a new access token and the current refresh token; for a bound
 *   session also the nonce for the client's next proof.
 * @throws AuthError `session.invalid_token`, `session.revoked`, `session.expired`,
 *   `session.reuse_detected` or `auth.user_banned`.
 * @throws AuthError `device.proof_invalid` or `device.nonce_required` when a bound session's
 *   refresh does not prove its key: the session is not ended.
 * @throws RateLimitError when a bound session's refused proofs are over their limit.
 */
export async function refresh(
  deps: SessionDeps & ProofDeps,
  scope: Scope,
  refreshToken: string,
  origin: Partial<Origin> = {},
  proof?: DeviceBinding.ProofRequest
): Promise<IssuedSession> {
  const tokenHash = sha256Hex(refreshToken)
  let proven = false
  // A second pass only happens when a concurrent request won the rotation between our read and
  // our write; the re-read then sees the token as used and takes the grace path.
  for (let pass = 0; pass < 2; pass++) {
    const now = deps.clock.now()
    const found = await deps.sessions.findToken(scope.environmentId, tokenHash)
    if (!found) {
      throw new AuthError('session.invalid_token')
    }
    const { token, session } = found
    if (session.type !== 'hybrid') {
      // A stateful session's token is a cookie checked on every request, never exchanged.
      throw new AuthError('session.invalid_token')
    }
    const issue = await configured(deps, scope, session)
    const { profile } = issue
    rejectEnded(session, profile, now)
    const { deviceThumbprint } = session
    if (deviceThumbprint !== null && !proven) {
      // Before the ban's revocation, reuse detection and the rotation: none of them is
      // reached, and nothing is written, for a request that does not prove the key.
      await DeviceBinding.atRefresh(deps, scope, { ...session, deviceThumbprint }, proof, origin)
      proven = true
    }
    const user = await rejectBanned(deps, scope, session, now, origin)
    const custom = await customClaims(deps, scope, issue, session, user)

    // Reuse is judged before the token's own expiry: a rotated token replayed on a live session
    // is theft however old it is, and must not be waved through as merely "expired".
    if (token.usedAt !== null) {
      return replayOrRevoke(
        deps,
        scope,
        { session, profile, token, custom },
        token.usedAt,
        now,
        origin
      )
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      throw new AuthError('session.expired')
    }

    const idleExpiresAt = idleExpiry(profile, now, limitsNow(profile, session).absoluteExpiresAt)
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
      const access = await signAccessToken(deps, scope, session, profile, now, signingKey, custom)
      return {
        sessionId: session.id,
        ...access,
        refreshToken: child,
        cookieMaxAge: durationToMs(profile.idleTimeout) / 1000,
        ...(deviceThumbprint !== null && { proofNonce: await DeviceBinding.nonce(deps, scope) }),
      }
    }
  }
  throw new InternalError({ internalMessage: 'refresh rotation lost the race twice' })
}

async function replayOrRevoke(
  deps: SessionDeps,
  scope: Scope,
  presented: {
    session: SessionRecord
    profile: SessionProfile
    token: RefreshTokenRecord
    custom: CustomClaims.Claims | undefined
  },
  usedAt: Date,
  now: Date,
  origin: Partial<Origin>
): Promise<IssuedSession> {
  const { session, profile, token, custom } = presented
  // No grace period (`null`) is strict rotation: every replay is reuse.
  const grace = profile.refresh.reuseGracePeriod
  const withinGrace = grace !== null && now.getTime() - usedAt.getTime() < durationToMs(grace)
  const child =
    withinGrace && token.replacedById
      ? await deps.sessions.findTokenById(scope.environmentId, token.replacedById)
      : null
  if (child && child.usedAt === null) {
    const signingKey = await Jwks.activeSigningKey(deps, scope.environmentId)
    const access = await signAccessToken(deps, scope, session, profile, now, signingKey, custom)
    return {
      sessionId: session.id,
      ...access,
      refreshToken: await deriveToken(deps, { parentId: token.id }),
      cookieMaxAge: durationToMs(profile.idleTimeout) / 1000,
      ...(session.deviceThumbprint !== null && {
        proofNonce: await DeviceBinding.nonce(deps, scope),
      }),
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

/**
 * Check a `stateful` session's token (the value of its cookie) against the session store, and
 * answer with the claims an access token would carry.
 *
 * This runs on every request of such a session, which is the point of the type: a revocation
 * is seen by the very next one, on every instance, with no denylist and no token lifetime in
 * between. The limits are those of the session's profile as configured now.
 *
 * Activity is written down at most once per `accessTokenTtl` of the profile (so the idle
 * timeout has that precision, as it has for a `hybrid` session), and always when less idle
 * time is left than that interval: a request never leaves a session to expire before the next
 * write could happen. That write is also when a ban is caught, as a refresh catches it for a
 * `hybrid` session.
 *
 * @param deps - Session store, settings, users, denylist, clock and ids.
 * @param scope - The environment the request resolved to.
 * @param sessionToken - The presented token.
 * @param origin - Where the request came from, recorded if the session has to be revoked.
 * @returns The session's claims: `sub`, `sid`, `auth_time`, `amr`, `sp` and the rest, with
 *   `iat` now and `exp` one `accessTokenTtl` from now (how long a caller may rely on them).
 * @throws AuthError `session.invalid_token` (unknown, another environment's, or a refresh
 *   token), `session.revoked`, `session.reuse_detected`, `session.expired` or
 *   `auth.user_banned`.
 */
export async function authenticate(
  deps: ProfileDeps & Pick<Deps, 'sessions' | 'revokedSessions' | 'users' | 'clock' | 'ids'>,
  scope: Scope,
  sessionToken: string,
  origin: Partial<Origin> = {}
): Promise<AccessTokenClaims> {
  const now = deps.clock.now()
  const found = await deps.sessions.findToken(scope.environmentId, sha256Hex(sessionToken))
  if (!found || found.session.type !== 'stateful') {
    throw new AuthError('session.invalid_token')
  }
  const { session } = found
  const issue = await configured(deps, scope, session)
  const { profile } = issue
  rejectEnded(session, profile, now)
  const interval = durationToMs(profile.accessTokenTtl)
  const idleLeft = limitsNow(profile, session).idleExpiresAt.getTime() - now.getTime()
  // Skipping the write is only safe while the session would survive until the next one. The
  // contract refuses a profile whose interval is longer than its idle timeout, but a document
  // stored before that rule can hold one, and an active user must never be timed out as idle.
  if (now.getTime() - session.lastActiveAt.getTime() < interval && idleLeft >= interval) {
    // The one read a template can add: the user, and only for a `user.*` source.
    const custom = await customClaims(deps, scope, issue, session)
    return claimsOf(deps, scope, session, profile, now, custom)
  }
  const user = await rejectBanned(deps, scope, session, now, origin)
  const custom = await customClaims(deps, scope, issue, session, user)
  const idleExpiresAt = idleExpiry(profile, now, limitsNow(profile, session).absoluteExpiresAt)
  if (!(await deps.sessions.touch(scope.environmentId, session.id, now, idleExpiresAt))) {
    // It ended between the read and the write.
    const ended = await deps.sessions.findById(scope.environmentId, session.id)
    throw new AuthError(ended?.revokedAt === null ? 'session.expired' : 'session.revoked')
  }
  return claimsOf(deps, scope, session, profile, now, custom)
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
    // A boolean and nothing of the key: the thumbprint never leaves the row and the token.
    deviceBound: record.deviceThumbprint !== null,
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
 * Sign out the session a refresh token, or a `stateful` session's token, belongs to.
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
