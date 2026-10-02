import {
  type ChangePasswordRequest,
  type CreateUserRequest,
  DEFAULT_PAGE_SIZE,
  durationToMs,
  type User,
  type UserList,
  type UserSort,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import {
  AuthError,
  ConflictError,
  InvalidEmailError,
  NotFoundError,
  RateLimitError,
} from '~/exceptions'
import { parseEmail } from '~/lib/email'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import type { UserRecord } from '~/ports/user-repository'

/** Current-password checks allowed per user in {@link PASSWORD_CHANGE_WINDOW}. */
export const PASSWORD_CHANGE_ATTEMPTS = 5
/** Window for {@link PASSWORD_CHANGE_ATTEMPTS}. */
export const PASSWORD_CHANGE_WINDOW = '15m'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

function toUser(record: UserRecord): User {
  return {
    id: record.id,
    email: record.email,
    emailVerifiedAt: record.emailVerifiedAt?.toISOString() ?? null,
    firstName: record.firstName,
    lastName: record.lastName,
    bannedAt: record.bannedAt?.toISOString() ?? null,
    lastSignInAt: record.lastSignInAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }
}

async function requireUser(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<UserRecord> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    throw new NotFoundError()
  }
  return user
}

/** Which users to list. Every field is optional. */
export interface ListInput {
  q?: string
  page?: number
  size?: number
  sort?: UserSort
}

/**
 * List an environment's users, one page at a time.
 *
 * @param deps - User repository.
 * @param scope - The environment.
 * @param input - Search, paging and sort (defaults: page 1, 20 per page, newest first).
 * @returns The page and its paging details.
 */
export async function list(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: ListInput
): Promise<UserList> {
  const page = input.page ?? 1
  const perPage = input.size ?? DEFAULT_PAGE_SIZE
  const { users, totalCount } = await deps.users.list(scope.environmentId, {
    q: input.q,
    page,
    size: perPage,
    sort: input.sort ?? '-createdAt',
  })
  return {
    meta: { totalCount, totalPages: Math.ceil(totalCount / perPage), page, perPage },
    data: users.map(toUser),
  }
}

/**
 * @param deps - User repository.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The user.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function get(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<User> {
  return toUser(await requireUser(deps, scope, userId))
}

/**
 * The signed-in user's own record.
 *
 * @param deps - User repository.
 * @param scope - The environment.
 * @param userId - The access token's subject.
 * @returns The user.
 * @throws NotFoundError when the account was deleted while its access token was still valid.
 */
export async function me(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<User> {
  return get(deps, scope, userId)
}

/**
 * Create a user from a server or the dashboard.
 *
 * The password must meet the environment's policy, exactly as at sign-up. Unlike sign-up, a
 * taken email is reported (`resource.conflict`): the caller holds a secret key, so there is
 * nothing to hide from them.
 *
 * @param deps - Users, password policy, breach checker, clock and ids.
 * @param scope - The project and environment.
 * @param input - Email, password, names and whether the email is already verified.
 * @returns The created user.
 * @throws InvalidEmailError, a `password.*` ServiceException, or ConflictError.
 */
export async function create(
  deps: Pick<Deps, 'users' | 'clock' | 'ids' | 'config' | 'breachChecker'>,
  scope: Scope,
  input: CreateUserRequest
): Promise<User> {
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const firstName = input.firstName?.trim() || null
  const lastName = input.lastName?.trim() || null
  await Passwords.assess(deps, scope, input.password, {
    email: parsed.email,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
  })
  const now = deps.clock.now()
  const record: UserRecord = {
    id: deps.ids.next(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    email: parsed.email,
    emailNormalized: parsed.normalized,
    emailVerifiedAt: input.emailVerified ? now : null,
    firstName,
    lastName,
    bannedAt: null,
    lastSignInAt: null,
    createdAt: now,
  }
  const created = await deps.users.createWithPassword({
    ...record,
    identityId: deps.ids.next(),
    credentialId: deps.ids.next(),
    passwordHash: await Passwords.hash(input.password),
  })
  if (!created) {
    throw new ConflictError({ message: 'A user with this email already exists.' })
  }
  return toUser(record)
}

type RevocationDeps = Pick<Deps, 'users' | 'sessions' | 'revokedSessions' | 'clock'>

/**
 * Ban a user: they can no longer sign in or refresh, and every session ends now.
 *
 * The ban is recorded before the sessions are revoked, so a sign-in racing the ban is stopped
 * either by the flow's ban check or, at the latest, by the ban check on its first refresh.
 *
 * @param deps - Users, sessions, denylist and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The banned user. Banning again keeps the original ban time.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function ban(
  deps: RevocationDeps,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<User> {
  const now = deps.clock.now()
  const user = await deps.users.setBanned(scope.environmentId, userId, now, now)
  if (!user) {
    throw new NotFoundError()
  }
  await Sessions.revokeAllForUser(deps, scope, userId, 'user_banned')
  return toUser(user)
}

/**
 * Lift a ban. The user has to sign in again; their old sessions stay revoked.
 *
 * Sessions are revoked once more before the ban is cleared: a sign-in that raced the ban may
 * have created one after the ban's own revocation, and it must not come back to life here.
 *
 * @param deps - Users, sessions, denylist and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The user.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function unban(
  deps: RevocationDeps,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<User> {
  await requireUser(deps, scope, userId)
  await Sessions.revokeAllForUser(deps, scope, userId, 'user_banned')
  const user = await deps.users.setBanned(scope.environmentId, userId, null, deps.clock.now())
  if (!user) {
    throw new NotFoundError()
  }
  return toUser(user)
}

/**
 * Delete a user and everything that belongs to them.
 *
 * Their sessions are revoked through the session service first, so their access tokens are
 * denylisted before the rows disappear.
 *
 * @param deps - Users, sessions, denylist and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function remove(
  deps: RevocationDeps,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<void> {
  await requireUser(deps, scope, userId)
  await Sessions.revokeAllForUser(deps, scope, userId, 'revoked_by_admin')
  if (!(await deps.users.delete(scope.environmentId, userId))) {
    throw new NotFoundError()
  }
}

type PasswordDeps = RevocationDeps & Pick<Deps, 'config' | 'breachChecker'>

async function replacePassword(
  deps: PasswordDeps,
  scope: Pick<Tenant, 'environmentId'>,
  user: UserRecord,
  password: string
): Promise<void> {
  await Passwords.assess(deps, scope, password, {
    email: user.email,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
  })
  const replaced = await deps.users.setPasswordHash(
    scope.environmentId,
    user.id,
    await Passwords.hash(password),
    deps.clock.now()
  )
  if (!replaced) {
    // Every user is created with a password today; when passwordless users exist (Phase 1)
    // this must create the credential instead. Never report success for a password not stored.
    throw new ConflictError({
      message: 'This user has no password to replace.',
      internalMessage: 'setPasswordHash matched no password credential',
    })
  }
}

/**
 * Set a user's password from a server or the dashboard (an admin reset).
 *
 * Every session of the user ends: whoever knew the old password is signed out everywhere.
 *
 * @param deps - Users, password policy, sessions, denylist and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @param password - The new password; must meet the policy.
 * @throws NotFoundError, a `password.*` ServiceException with per-field `errors`, or
 *   ConflictError when the user has no password credential.
 */
export async function setPassword(
  deps: PasswordDeps,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string,
  password: string
): Promise<void> {
  const user = await requireUser(deps, scope, userId)
  await replacePassword(deps, scope, user, password)
  await Sessions.revokeAllForUser(deps, scope, userId, 'password_changed')
}

/**
 * Change the signed-in user's own password.
 *
 * The current password must be given, so a stolen access token alone cannot take the account
 * over; guesses at it are limited per user. On success every *other* session ends and the
 * device making the change stays signed in.
 *
 * @param deps - Users, password policy, sessions, denylist, rate limiter and clock.
 * @param scope - The environment.
 * @param actor - The signed-in user and their current session.
 * @param input - Current and new password.
 * @throws AuthError `auth.invalid_credentials` when the current password is wrong.
 * @throws RateLimitError after too many wrong guesses.
 * @throws ServiceException a `password.*` code when the new password fails the policy.
 */
export async function changePassword(
  deps: PasswordDeps & Pick<Deps, 'rateLimiter'>,
  scope: Pick<Tenant, 'environmentId'>,
  actor: { userId: string; sessionId: string },
  input: ChangePasswordRequest
): Promise<void> {
  const limit = await deps.rateLimiter.hit(
    `password_change:${scope.environmentId}:${actor.userId}`,
    PASSWORD_CHANGE_ATTEMPTS,
    durationToMs(PASSWORD_CHANGE_WINDOW)
  )
  if (!limit.allowed) {
    throw new RateLimitError(limit.retryAfterMs)
  }
  const user = await deps.users.findById(scope.environmentId, actor.userId)
  const found = user
    ? await deps.users.findByEmailWithPassword(scope.environmentId, user.emailNormalized)
    : null
  if (!(await Passwords.verify(found?.passwordHash ?? null, input.currentPassword)) || !found) {
    throw new AuthError('auth.invalid_credentials')
  }
  await replacePassword(deps, scope, found.user, input.newPassword)
  await Sessions.revokeOthers(deps, scope, {
    userId: actor.userId,
    currentSessionId: actor.sessionId,
    reason: 'password_changed',
  })
}
