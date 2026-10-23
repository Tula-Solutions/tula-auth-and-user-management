import {
  type ChangePasswordRequest,
  type CreateUserRequest,
  type CurrentUser,
  DEFAULT_PAGE_SIZE,
  type ErrorCode,
  errorDefinition,
  type ImportRowResult,
  type ImportUserRow,
  type ImportUsersRequest,
  type ImportUsersResult,
  MAX_IMPORT_METADATA_BYTES,
  type OAuthProvider,
  type ProposalApprover,
  type User,
  type UserAuthentication,
  type UserList,
  type UserSort,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import {
  AuthError,
  ConflictError,
  InvalidEmailError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
} from '~/exceptions'
import { type Actor, cleanOrigin, type Origin } from '~/lib/actor'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as Passkeys from '~/modules/passkey/service'
import * as Foreign from '~/modules/password/foreign-hash'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
import {
  InvalidUserDataError,
  type PasswordOutcome,
  type UserRecord,
} from '~/ports/user-repository'

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
    phoneNumber: record.phoneNumber,
    phoneNumberVerifiedAt: record.phoneNumberVerifiedAt?.toISOString() ?? null,
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
 * @returns The user, and whether they have a password (never the credential itself).
 * @throws NotFoundError when the account was deleted while its access token was still valid.
 */
export async function me(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<CurrentUser> {
  const user = await requireUser(deps, scope, userId)
  const found = await Passwords.ofUser(deps, scope.environmentId, user)
  return { ...toUser(user), hasPassword: Boolean(found?.passwordHash) }
}

/**
 * How a user signs in: the methods the account has, for a server or the dashboard.
 *
 * Put together from what each module already says about a user (`Mfa.status`,
 * `Passkeys.list`, the user's identities), so nothing here reads a secret: the answer has no
 * password hash, authenticator secret, backup code, credential id, public key or provider
 * subject to leak. A pending authenticator enrolment is not a factor.
 *
 * `canSignInWithoutPasskeys` is the answer {@link Mfa.reset} would give for this user now: an
 * admin sees before resetting whether it would lock the account out.
 *
 * @param deps - Users, factors, passkeys, settings and the provider store.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The user's sign-in methods.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function authentication(
  deps: Pick<
    Deps,
    'users' | 'factors' | 'passkeys' | 'environmentSettings' | 'config' | 'oauthProviders' | 'sms'
  >,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<UserAuthentication> {
  const user = await requireUser(deps, scope, userId)
  const found = await Passwords.ofUser(deps, scope.environmentId, user)
  const hasPassword = Boolean(found?.passwordHash)
  const emailVerified = user.emailVerifiedAt !== null
  const identities = await OAuth.identities(deps, scope, userId)
  const { totp, backupCodes, sms } = await Mfa.status(deps, scope, userId)
  return {
    hasPassword,
    emailVerified,
    identities: identities.map(({ provider, createdAt }) => ({ provider, linkedAt: createdAt })),
    factors: [
      ...(totp.confirmedAt === null ? [] : [{ type: 'totp', confirmedAt: totp.confirmedAt }]),
      // A texted code as the second factor (ADR 0025). The type and the time: never the number.
      ...(sms?.enabledAt ? [{ type: 'sms', confirmedAt: sms.enabledAt }] : []),
    ],
    backupCodesRemaining: backupCodes.remaining,
    passkeys: await Passkeys.list(deps, scope, userId),
    canSignInWithoutPasskeys: OAuth.canStillSignIn(
      await Settings.current(deps, scope),
      await OAuth.enabledProviders(deps, scope),
      {
        hasPassword,
        emailVerified,
        providers: identities.map((identity) => identity.provider as OAuthProvider),
        passkeys: 0,
      }
    ),
  }
}

/**
 * Create a user from a server or the dashboard.
 *
 * A password, when given, must meet the environment's policy, exactly as at sign-up. Without
 * one the user is created with no password credential: they sign in another way, and get a
 * password through a password reset or {@link setPassword}. Unlike sign-up, a taken email is
 * reported (`resource.conflict`): the caller holds a secret key, so there is nothing to hide
 * from them.
 *
 * @param deps - Users, password policy, breach checker, clock and ids.
 * @param scope - The project and environment.
 * @param input - Email, optional password, names and whether the email is already verified.
 * @param actor - Who is creating the user, for the audit log.
 * @returns The created user.
 * @throws InvalidEmailError, a `password.*` ServiceException, or ConflictError.
 */
export async function create(
  deps: Pick<Deps, 'users' | 'clock' | 'ids' | 'config' | 'environmentSettings' | 'breachChecker'>,
  scope: Scope,
  input: CreateUserRequest,
  actor: Actor
): Promise<User> {
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const firstName = input.firstName?.trim() || null
  const lastName = input.lastName?.trim() || null
  if (input.password !== undefined) {
    await Passwords.assess(deps, scope, input.password, {
      email: parsed.email,
      firstName: firstName ?? undefined,
      lastName: lastName ?? undefined,
    })
  }
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
    phoneNumber: null,
    phoneNumberVerifiedAt: null,
    smsFactorEnabledAt: null,
  }
  const created = await deps.users.create(
    {
      ...record,
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: input.password === undefined ? null : await Passwords.hash(input.password),
    },
    Audit.entry(deps, scope, {
      type: 'user.created',
      actor,
      target: { type: 'user', id: record.id },
      data: {
        method: 'admin',
        emailVerified: record.emailVerifiedAt !== null,
        ...(input.password === undefined && { passwordless: true }),
      },
    })
  )
  if (!created) {
    throw new ConflictError({ message: 'A user with this email already exists.' })
  }
  return toUser(record)
}

/** Split a full name at its first run of whitespace; each half fits a name column. */
function splitName(name: string | undefined): {
  firstName: string | null
  lastName: string | null
} {
  const trimmed = name?.trim() ?? ''
  if (trimmed === '') {
    return { firstName: null, lastName: null }
  }
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const last = rest.join(' ')
  return {
    firstName: [...first].slice(0, 100).join(''),
    lastName: last === '' ? null : [...last].slice(0, 100).join(''),
  }
}

/** Whether a string can be stored: no NUL (`text` and `jsonb` refuse it) and no lone surrogate. */
function storable(text: string | undefined): boolean {
  return text === undefined || (!text.includes('\u0000') && !LONE_SURROGATE.test(text))
}

/** The deepest nesting a row's metadata may have (the object itself is level 1). */
const MAX_IMPORT_METADATA_DEPTH = 32

/** A UTF-16 surrogate with no partner (`String.prototype.isWellFormed` is not in the TS lib). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/**
 * Whether every key and value of a metadata object can be stored by the database and the
 * object fits {@link MAX_IMPORT_METADATA_BYTES} **as `jsonb` prints it** (the column's check
 * measures `metadata::text`).
 *
 * `jsonb` prints a space after every `:` and `,` and rewrites numbers, so the compact JSON
 * is measured with one extra byte for each structural `:` and `,`, and a number JSON writes
 * with an exponent is refused (`jsonb` would write it out in full, which can be far longer).
 * A NUL or a lone surrogate in any key or string is refused: `jsonb` rejects both.
 */
function metadataFits(metadata: Record<string, unknown>): boolean {
  // Iterative on purpose: the contract's z.unknown() does not bound depth, and recursing over
  // (or stringifying) a 100,000-deep array overflows the stack, which would fail the whole call
  // after earlier rows were committed. The depth is judged before any JSON.stringify.
  const pending: { value: unknown; depth: number }[] = [{ value: metadata, depth: 1 }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next
    if (typeof value === 'string') {
      if (!storable(value)) {
        return false
      }
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || /e/i.test(String(value))) {
        return false
      }
    } else if (value !== null && typeof value === 'object') {
      if (depth > MAX_IMPORT_METADATA_DEPTH) {
        return false
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          pending.push({ value: child, depth: depth + 1 })
        }
      } else {
        for (const [key, child] of Object.entries(value)) {
          if (!storable(key)) {
            return false
          }
          pending.push({ value: child, depth: depth + 1 })
        }
      }
    }
  }
  const compact = JSON.stringify(metadata)
  let bytes = new TextEncoder().encode(compact).length
  let inString = false
  for (let at = 0; at < compact.length; at += 1) {
    const char = compact[at]
    if (inString) {
      if (char === '\\') {
        at += 1
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
    } else if (char === ':' || char === ',') {
      bytes += 1
    }
  }
  return bytes <= MAX_IMPORT_METADATA_BYTES
}

function refusal(index: number, code: ErrorCode): ImportRowResult {
  return { index, status: 'refused', code, message: errorDefinition(code).message }
}

/**
 * Create the users of one import (`POST /v1/admin/users/import`, ADR 0066), each in a
 * transaction of its own.
 *
 * The call is not all-or-nothing: a row that is refused, or that is a duplicate, does not
 * stop the rest, and the answer says what became of every row. A row is atomic: the user, their
 * identity, their credential and their `user.imported` audit entry are written together or
 * not at all. Running the same call again is safe: rows already imported are reported as
 * skipped, which makes a resumed import idempotent by normalized email.
 *
 * A row's password hash is parsed and judged ({@link Foreign.parse}) and then stored as given:
 * it is verified with its own algorithm at the user's first sign-in and replaced there by an
 * argon2id hash of the same password (`Passwords.needsRehash`). The environment's password
 * policy and the breached-password check are not applied: only the user knows the plaintext.
 * The password's age starts at the import, and it has no history (ADR 0066).
 *
 * @param deps - Users, clock and ids.
 * @param scope - The project and environment.
 * @param input - The rows, in order.
 * @param actor - The administrator running the import, recorded on every entry.
 * @returns One result per row, in order, with the counts.
 */
export async function importUsers(
  deps: Pick<Deps, 'users' | 'clock' | 'ids'>,
  scope: Scope,
  input: ImportUsersRequest,
  actor: Actor
): Promise<ImportUsersResult> {
  const seen = new Set<string>()
  const results: ImportRowResult[] = []
  for (const [index, row] of input.users.entries()) {
    results.push(await importRow(deps, scope, row, index, seen, actor))
  }
  const count = (status: ImportRowResult['status']) =>
    results.filter((result) => result.status === status).length
  return {
    results,
    created: count('created'),
    skipped: count('skipped'),
    refused: count('refused'),
  }
}

async function importRow(
  deps: Pick<Deps, 'users' | 'clock' | 'ids'>,
  scope: Scope,
  row: ImportUserRow,
  index: number,
  seen: Set<string>,
  actor: Actor
): Promise<ImportRowResult> {
  const parsed = parseEmail(row.email)
  if (!parsed) {
    return refusal(index, 'email.invalid')
  }
  if (seen.has(parsed.normalized)) {
    return { index, status: 'skipped', reason: 'repeated_in_batch' }
  }
  if (
    !storable(row.name) ||
    !storable(row.externalId) ||
    (row.metadata !== undefined && !metadataFits(row.metadata))
  ) {
    return refusal(index, 'validation.failed')
  }
  let algorithm: Foreign.ImportAlgorithm | undefined
  if (row.password !== undefined) {
    const judged = Foreign.parse(row.password.algorithm, row.password.hash)
    if (!judged.ok) {
      return refusal(index, judged.code)
    }
    algorithm = judged.algorithm
  }
  const now = deps.clock.now()
  const id = deps.ids.next()
  let created: boolean
  try {
    created = await deps.users.create(
      {
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        email: parsed.email,
        emailNormalized: parsed.normalized,
        emailVerifiedAt: row.emailVerified ? now : null,
        ...splitName(row.name),
        createdAt: now,
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: row.password?.hash ?? null,
        ...(row.externalId !== undefined && { externalId: row.externalId }),
        ...(row.metadata !== undefined && { metadata: row.metadata }),
      },
      Audit.entry(deps, scope, {
        type: 'user.imported',
        actor,
        target: { type: 'user', id },
        data: {
          emailVerified: row.emailVerified,
          ...(algorithm === undefined ? { passwordless: true } : { passwordAlgorithm: algorithm }),
        },
      })
    )
  } catch (error) {
    // The store's own check refused what the pre-check let through: that row alone is
    // refused, and the rows before it stay (ADR 0066).
    if (error instanceof InvalidUserDataError) {
      return refusal(index, 'validation.failed')
    }
    throw error
  }
  // Taken in either case from here on, whether this row made the user or found them there.
  seen.add(parsed.normalized)
  return created
    ? { index, status: 'created', id }
    : { index, status: 'skipped', reason: 'email_exists' }
}

type RevocationDeps = Pick<Deps, 'users' | 'sessions' | 'revokedSessions' | 'clock' | 'ids'>

/**
 * Ban a user: they can no longer sign in or refresh, and every session ends now.
 *
 * The ban is recorded before the sessions are revoked, so a sign-in racing the ban is stopped
 * either by the flow's ban check or, at the latest, by the ban check on its first refresh.
 *
 * @param deps - Users, sessions, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param actor - Who is banning them, for the audit log.
 * @param proposal - When the ban carries out an agent's proposal a human approved (ADR
 *   0053): the proposal and who approved it, recorded in the entry beside the agent actor.
 *   Only `Proposals.approve` passes it.
 * @returns The banned user. Banning again keeps the original ban time.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function ban(
  deps: RevocationDeps,
  scope: Scope,
  userId: string,
  actor: Actor,
  proposal?: { proposalId: string; approvedBy: ProposalApprover }
): Promise<User> {
  const now = deps.clock.now()
  const user = await deps.users.setBanned(
    scope.environmentId,
    userId,
    now,
    now,
    Audit.entry(deps, scope, {
      type: 'user.banned',
      actor,
      target: { type: 'user', id: userId },
      data: proposal ? { proposalId: proposal.proposalId, approvedBy: proposal.approvedBy } : {},
    })
  )
  if (!user) {
    throw new NotFoundError()
  }
  await Sessions.revokeAllForUser(deps, scope, userId, 'user_banned', actor)
  return toUser(user)
}

/**
 * Lift a ban. The user has to sign in again; their old sessions stay revoked.
 *
 * Sessions are revoked once more before the ban is cleared: a sign-in that raced the ban may
 * have created one after the ban's own revocation, and it must not come back to life here.
 *
 * @param deps - Users, sessions, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param actor - Who is lifting the ban, for the audit log.
 * @param proposal - The approved proposal this carries out (ADR 0053), named in the entry;
 *   left out for an administrator's own change.
 * @returns The user.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function unban(
  deps: RevocationDeps,
  scope: Scope,
  userId: string,
  actor: Actor,
  proposal?: { proposalId: string; approvedBy: ProposalApprover }
): Promise<User> {
  return (await liftBan(deps, scope, userId, actor, proposal)).user
}

/**
 * Lift a ban and say whether one was lifted: {@link unban}, for a caller that reports what
 * the call did (an approved proposal, ADR 0053).
 *
 * `lifted` is said by the branch that writes, not by a look a caller made earlier: it is
 * `true` exactly when this call cleared the ban and wrote its `user.unbanned` entry.
 *
 * @param deps - Users, sessions, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param actor - Who is lifting the ban, for the audit log.
 * @param proposal - The approved proposal this carries out, named in the entry; left out
 *   for an administrator's own change.
 * @returns The user, and whether this call lifted a ban (`false`: nobody had banned them,
 *   nothing was written and nobody was signed out).
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function liftBan(
  deps: RevocationDeps,
  scope: Scope,
  userId: string,
  actor: Actor,
  proposal?: { proposalId: string; approvedBy: ProposalApprover }
): Promise<{ user: User; lifted: boolean }> {
  const current = await requireUser(deps, scope, userId)
  if (current.bannedAt === null) {
    // Not banned: nothing to lift, and no reason to sign them out.
    return { user: toUser(current), lifted: false }
  }
  await Sessions.revokeAllForUser(deps, scope, userId, 'user_banned', actor)
  const user = await deps.users.setBanned(
    scope.environmentId,
    userId,
    null,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.unbanned',
      actor,
      target: { type: 'user', id: userId },
      data: proposal ? { proposalId: proposal.proposalId, approvedBy: proposal.approvedBy } : {},
    })
  )
  if (!user) {
    throw new NotFoundError()
  }
  return { user: toUser(user), lifted: true }
}

/**
 * Delete a user and everything that belongs to them.
 *
 * Their sessions are revoked through the session service first, so their access tokens are
 * denylisted before the rows disappear.
 *
 * The audit entries about the user outlive them: the log names them by id only.
 *
 * @param deps - Users, sessions, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param actor - Who is deleting them, for the audit log.
 * @throws NotFoundError when they do not exist in this environment.
 */
export async function remove(
  deps: RevocationDeps,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<void> {
  await requireUser(deps, scope, userId)
  await Sessions.revokeAllForUser(deps, scope, userId, 'revoked_by_admin', actor)
  const deleted = await deps.users.delete(
    scope.environmentId,
    userId,
    Audit.entry(deps, scope, { type: 'user.deleted', actor, target: { type: 'user', id: userId } })
  )
  if (!deleted) {
    throw new NotFoundError()
  }
}

type PasswordDeps = RevocationDeps &
  Pick<Deps, 'config' | 'environmentSettings' | 'breachChecker' | 'mailer' | 'rateLimiter'>

/**
 * How often storing a password is tried when the stored password moved between the comparison
 * with the user's previous passwords and the write (ADR 0038). Each pass needs another password
 * change, or a hash upgrade at sign-in, of the same user to land inside it.
 */
const PASSWORD_STORE_ATTEMPTS = 3

/**
 * How many times the sessions of a user are tried to be ended after an expired password was
 * replaced, before the request gives up with a 503 (ADR 0041).
 */
const EXPIRED_PASSWORD_SWEEP_ATTEMPTS = 3

/**
 * The pause before the second try of that sweep, in milliseconds; the one before the third is
 * twice as long. Short on purpose: the user is waiting, and a store that is away for longer
 * than a blink is not waited out by a request.
 */
const EXPIRED_PASSWORD_SWEEP_PAUSE_MS = 20

/** How a password notice names each way a password is stored. */
const CHANGED_BY = { admin_reset: 'admin', self: 'self', reset: 'reset' } as const

/**
 * Check, hash and store a user's password: a replacement, or their first one.
 *
 * A user with no password credential gets one created (the store reports which happened and
 * marks the audit entry `created: true`), so an admin "set password" and a password reset both
 * work for someone who signed up another way.
 *
 * Once the password is stored the account's owner is told by email (`Notices.passwordChanged`,
 * ADR 0023). That happens here, straight after the store and before anything else the caller
 * still does, so no path stores a password without it and a later failure (ending the other
 * sessions, clearing the lockout) cannot leave a changed password unannounced. The notice is
 * sent in the background and cannot fail or delay the change.
 *
 * Where the environment's `password.history` is at least 1, a user's own password (a change, a
 * reset) is refused with `password.reused` when it is one of their last that many, the current
 * one included; an administrator's is not compared. Either way the store keeps the hash that
 * stops being current and deletes what the policy no longer keeps, in the transaction that
 * stores the new one (ADR 0038).
 *
 * @param expired - Given when the password replaces one that has expired, by a sign-in that
 *   proved it (`setAt`: when the password it proved was set). The expired password is then
 *   refused as its own replacement whatever the history says, and nothing is compared or
 *   stored once the stored password is no longer that one (`flow.invalid_step`).
 */
async function replacePassword(
  deps: PasswordDeps,
  scope: Scope,
  user: UserRecord,
  password: string,
  actor: Actor,
  method: 'admin_reset' | 'self' | 'reset',
  beforeStore?: () => Promise<void>,
  expired?: { setAt: number }
): Promise<void> {
  const { email, emailNormalized } = user
  if (email === null || emailNormalized === null) {
    // A password sign-in starts with an address. On an account that has none (made through X
    // or Facebook; ADR 0026) a password would be a credential nobody can use, and one that
    // "a way to sign in" would then wrongly count when the account's last identity is removed.
    throw new ConflictError({
      message: 'This account has no email address, so it cannot sign in with a password.',
    })
  }
  await Passwords.assess(deps, scope, password, {
    email,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
  })
  const { history } = await Passwords.policy(deps, scope)
  // A password that replaces an expired one is never that same password, whatever the
  // history says: with `history: 0` the user could otherwise set it again, and the expiry
  // would have asked for nothing (ADR 0041). What is *kept* stays the policy's own number.
  const refused = expired ? Math.max(history, 1) : history
  // An administrator's password is kept in the history and never refused by it: they do not
  // know the user's old passwords, and a refusal would tell them a candidate is one of them.
  const compared = refused > 0 && method !== 'admin_reset'
  /**
   * Compare the new password with the stored ones, and return the hash it was judged against.
   *
   * For an expired password the comparison is made only while the stored password is still
   * the one the sign-in proved, and that is asked again before every comparison: by when the
   * password was set, which a replacement always moves (the store sees to it, whatever the
   * writer's clock says) and a hash upgrade never does. So a hash upgrade that lands
   * meanwhile (another tab signing in) costs a pass and nothing else, and a replacement ends
   * in `flow.invalid_step` before anything is counted or verified. The hash read with that
   * time is handed on as `proven`, and the write is a compare-and-set on it: a change between
   * this read and either of those is seen there, and asked about again here.
   */
  async function compare(counted: boolean): Promise<string | null> {
    if (!expired) {
      return Passwords.assertNotReused(deps, scope, user.id, password, refused, counted)
    }
    for (let pass = 1; ; pass++) {
      const found = await Passwords.ofUser(deps, scope.environmentId, user)
      if (
        !found ||
        found.passwordHash === null ||
        found.passwordChangedAt?.getTime() !== expired.setAt
      ) {
        throw new AuthError('flow.invalid_step')
      }
      try {
        return await Passwords.assertNotReused(
          deps,
          scope,
          user.id,
          password,
          refused,
          counted,
          found.passwordHash
        )
      } catch (error) {
        // `flow.invalid_step` from there means the hash moved after the read above, and
        // nothing was counted or verified: read again and let the time say which it was.
        const moved = error instanceof AuthError && error.code === 'flow.invalid_step'
        if (!moved || pass >= PASSWORD_STORE_ATTEMPTS) {
          throw error
        }
      }
    }
  }
  // Last of the checks, and only here: whoever reaches it has proven the account is theirs
  // and offered a password the policy accepts (ADR 0038).
  let judgedAgainst = compared ? await compare(true) : undefined
  // Hash first: a failure here must leave whatever `beforeStore` spends untouched.
  const passwordHash = await Passwords.hash(password)
  await beforeStore?.()
  const now = deps.clock.now()
  let outcome: PasswordOutcome | 'stale' | null = 'stale'
  for (let pass = 0; pass < PASSWORD_STORE_ATTEMPTS && outcome === 'stale'; pass++) {
    if (pass > 0) {
      // The password changed between the comparison and the write (another change, or a hash
      // upgrade at sign-in): compare again with what is stored now. Not counted twice.
      judgedAgainst = await compare(false)
    }
    outcome = await deps.users.setPasswordHash(
      scope.environmentId,
      user.id,
      passwordHash,
      now,
      Audit.entry(deps, scope, {
        type: 'user.password_changed',
        actor,
        target: { type: 'user', id: user.id },
        data: { method },
      }),
      {
        keep: Passwords.previousKept(history),
        ...(compared && { ifCurrent: judgedAgainst ?? null }),
      }
    )
  }
  if (outcome === 'stale') {
    // Nothing was stored. Never store a password on a comparison that no longer holds.
    throw new ServiceUnavailableError({
      internalMessage: 'the password kept changing while its history was being compared',
    })
  }
  if (outcome === null) {
    // The user was deleted after the caller loaded them. Never report success for a password
    // that was not stored.
    throw new NotFoundError()
  }
  Notices.passwordChanged(deps, scope, user, {
    by: CHANGED_BY[method],
    added: outcome === 'created',
    at: now,
  })
}

/**
 * Give a user who has **no** email address one, from a server or the dashboard (ADR 0059).
 *
 * The address is stored **unverified**: nobody has proven it. It signs nobody in by itself
 * and counts for nothing that asks for a verified address; whoever reads its inbox proves
 * it with the first emailed sign-in code or password reset they complete, exactly as for
 * a user an administrator created. The user's own way (`modules/email-address`) stores a
 * proven one.
 *
 * Never replaces an address, and the store's unique key decides who has one: an address
 * another user holds is the conflict a create answers. No session ends and nothing is
 * emailed: the account is not less protected than it was, and an unproven address is not
 * told anything.
 *
 * @param deps - Users, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param email - The address as given.
 * @param actor - Who is setting it, for the audit log.
 * @returns The user as they now are.
 * @throws InvalidEmailError for what is not an address.
 * @throws NotFoundError for an unknown user.
 * @throws AuthError `email.already_set` for a user who has an address.
 * @throws ConflictError when another user of the environment has the address.
 */
export async function setEmail(
  deps: Pick<Deps, 'users' | 'ids' | 'clock' | 'config'>,
  scope: Scope,
  userId: string,
  email: string,
  actor: Actor
): Promise<User> {
  const parsed = parseEmail(email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const user = await requireUser(deps, scope, userId)
  if (user.email !== null) {
    throw new AuthError('email.already_set')
  }
  const now = deps.clock.now()
  const stored = await deps.users.addEmail(
    scope.environmentId,
    userId,
    {
      email: parsed.email,
      normalized: parsed.normalized,
      verifiedAt: null,
      identityId: deps.ids.next(),
    },
    now,
    Audit.entry(deps, scope, {
      type: 'user.email_added',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'admin', verified: false },
    })
  )
  if (stored === 'not_found') {
    throw new NotFoundError()
  }
  if (stored === 'has_email') {
    throw new AuthError('email.already_set')
  }
  if (stored === 'taken') {
    throw new ConflictError({ message: 'A user with this email already exists.' })
  }
  return toUser(stored)
}

/**
 * Set a user's password from a server or the dashboard (an admin reset). A user who has no
 * password gets their first one.
 *
 * Every session of the user ends: whoever knew the old password is signed out everywhere. The
 * sign-in lockout for their address is cleared, so earlier wrong guesses don't keep them out.
 * The user is emailed that an administrator set their password (ADR 0023).
 *
 * @param deps - Users, password policy, sessions, denylist, lockout, mailer, limiter, ids and
 *   clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param password - The new password; must meet the policy.
 * @param actor - Who is resetting it, for the audit log.
 * @throws NotFoundError, or a `password.*` ServiceException with per-field `errors`.
 */
export async function setPassword(
  deps: PasswordDeps & Pick<Deps, 'lockout'>,
  scope: Scope,
  userId: string,
  password: string,
  actor: Actor
): Promise<void> {
  const user = await requireUser(deps, scope, userId)
  await replacePassword(deps, scope, user, password, actor, 'admin_reset')
  await Sessions.revokeAllForUser(deps, scope, userId, 'password_changed', actor)
  // Guesses at the old password must not keep the user out of the new one they were just given.
  // (`replacePassword` refused an account with no address, so there is one to clear for.)
  if (user.emailNormalized !== null) {
    await deps.lockout.clear(signInLockKey(scope.environmentId, user.emailNormalized))
  }
}

/**
 * Replace a user's password after they proved control of their email (a forgotten password),
 * or create it for a user who has none: this is how someone who signed up another way sets
 * their first password.
 *
 * Like {@link setPassword}, every session ends and the sign-in lockout is cleared. The caller's
 * proof is spent by `claim`, which runs once the new password has passed the policy and been
 * hashed, and before anything changes: a rejected password does not use the proof up, and of
 * two requests with the same proof only one stores a password.
 *
 * The sessions end **before** the password is stored, and are swept once more after it. If the
 * first sweep or the store fails, the account is never left with a new password and the old
 * sessions still alive, which is the one state a reset exists to prevent; the second sweep
 * catches a sign-in with the old password that landed in between. Clearing the lockout
 * afterwards is best-effort. The user is emailed that their password was reset (ADR 0023).
 *
 * @param deps - Users, password policy, sessions, denylist, lockout, mailer, limiter, ids and
 *   clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param password - The new password; must meet the policy.
 * @param actor - The user themselves, with the request's origin, for the audit log.
 * @param claim - Spends the proof; throw to refuse.
 * @throws NotFoundError, a `password.*` ServiceException with per-field `errors`, or whatever
 *   `claim` throws.
 */
export async function resetPassword(
  deps: PasswordDeps & Pick<Deps, 'lockout'>,
  scope: Scope,
  userId: string,
  password: string,
  actor: Actor,
  claim: () => Promise<void>
): Promise<void> {
  const user = await requireUser(deps, scope, userId)
  await replacePassword(deps, scope, user, password, actor, 'reset', async () => {
    await claim()
    await Sessions.revokeAllForUser(deps, scope, userId, 'password_changed', actor)
  })
  // Again, now that the old password no longer works: someone who knew it could have signed in
  // between the first sweep and the store, and that session must not outlive the reset.
  await Sessions.revokeAllForUser(deps, scope, userId, 'password_changed', actor)
  try {
    if (user.emailNormalized !== null) {
      await deps.lockout.clear(signInLockKey(scope.environmentId, user.emailNormalized))
    }
  } catch (error) {
    // The password is stored; a lockout left in place only delays the next sign-in.
    logger.warn('could not clear the sign-in lockout after a password reset', {
      environmentId: scope.environmentId,
      err: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/**
 * Replace a password that has expired, for a user who has just proved it at a sign-in and
 * has no session yet (`Flows.replaceExpiredPassword`, ADR 0041).
 *
 * It is the user's own change, proven by the current password: recorded and announced as
 * one (`user.password_changed` with `method: 'self'`), compared with their previous
 * passwords as one, and counted against the same hourly allowance. Two things differ. **The
 * expired password itself is always refused** (`password.reused`, with `params.history` of at
 * least 1), also where `password.history` is 0: otherwise the user would type the old
 * password again and the expiry would have changed nothing. And **every session of the user
 * ends**, not every other one: the sign-in that asked has none yet, and its own is created
 * after this returns. They end **after** the password is stored, as for a user's own change
 * and unlike a reset: of two requests at once only the one whose password was stored ends
 * anything, so the one that lost cannot end the session the other's sign-in has just been
 * given.
 *
 * **A sweep that fails is tried again, and then said.** The password is stored by then and
 * cannot be taken back, so the sweep is tried `EXPIRED_PASSWORD_SWEEP_ATTEMPTS` times, a few
 * tens of milliseconds apart. If none works the answer is `service.unavailable` (503), nobody
 * is signed in, and an error is logged with the environment and the user's id: the password
 * is the new one, and the sessions made under the old one live on until they end by
 * themselves or an administrator ends them (`DELETE /v1/admin/users/:userId/sessions`).
 * Nothing remembers that the sweep is owed (ADR 0041).
 *
 * @param deps - Users, password policy, sessions, denylist, mailer, limiter, ids and clock.
 * @param scope - The project and environment.
 * @param user - The user, as the sign-in loaded them.
 * @param password - The new password; must meet the policy.
 * @param actor - The user themselves, with the request's origin, for the audit log.
 * @param setAt - When the expired password the sign-in proved was set, in milliseconds.
 *   Nothing is compared or stored unless the stored password is still that one.
 * @throws AuthError `flow.invalid_step` when the stored password is no longer the one the
 *   sign-in proved.
 * @throws ServiceUnavailableError when the password was stored and the user's earlier
 *   sessions could not be ended.
 * @throws NotFoundError, or a `password.*` ServiceException with per-field `errors`
 *   (`password.reused` among them).
 * @throws RateLimitError when the user's allowance of history comparisons is used up.
 */
export async function replaceExpiredPassword(
  deps: PasswordDeps,
  scope: Scope,
  user: UserRecord,
  password: string,
  actor: Actor,
  setAt: number
): Promise<void> {
  await replacePassword(deps, scope, user, password, actor, 'self', undefined, { setAt })
  for (let attempt = 1; ; attempt++) {
    try {
      await Sessions.revokeAllForUser(deps, scope, user.id, 'password_changed', actor)
      return
    } catch {
      if (attempt >= EXPIRED_PASSWORD_SWEEP_ATTEMPTS) {
        break
      }
      await Bun.sleep(EXPIRED_PASSWORD_SWEEP_PAUSE_MS * attempt)
    }
  }
  // Fixed words and two ids: nothing of the failure, which may hold a connection string. This
  // line is the only trace that the sessions are still to be ended: never drop or quieten it.
  logger.error(
    'a password that replaced an expired one was stored, and the user’s earlier sessions could not be ended',
    { environmentId: scope.environmentId, userId: user.id }
  )
  throw new ServiceUnavailableError({
    internalMessage: 'sessions not ended after an expired password was replaced',
  })
}

/**
 * Change the signed-in user's own password.
 *
 * The current password must be given, so a stolen access token alone cannot take the account
 * over; wrong guesses back off exponentially per user (`CREDENTIAL_LOCKOUT`), and a correct one
 * clears them. They are counted under `Mfa.stepUpLockKey`, the key a password step-up counts
 * under: whoever holds a session has one budget of guesses at the password, whichever route
 * they try it on (ADR 0011). On success every *other* session ends and the
 * device making the change stays signed in. The user is emailed that their password was changed
 * (ADR 0023).
 *
 * An account with no password (it signs in another way) answers `password.not_set`: there is no
 * current password to prove, and a first password is **not** set through this route, because an
 * access token alone would then be enough to add a credential to the account. A first password
 * is set through the password reset flow, which proves the inbox, or by an admin. The answer is
 * about the caller's own account only (the user id comes from their access token), so it tells
 * nobody anything about anyone else; it is given before the lockout is counted, since nothing
 * was guessed.
 *
 * @param deps - Users, password policy, sessions, denylist, lockout, mailer, limiter, ids and
 *   clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their current session.
 * @param input - Current and new password.
 * @param origin - Where the request came from, for the audit log.
 * @throws AuthError `auth.invalid_credentials` when the current password is wrong, or
 *   `password.not_set` (409) when the account has no password.
 * @throws RateLimitError while the user is locked out after repeated wrong guesses.
 * @throws ServiceException a `password.*` code when the new password fails the policy.
 */
export async function changePassword(
  deps: PasswordDeps & Pick<Deps, 'lockout'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  input: ChangePasswordRequest,
  origin: Partial<Origin> = {}
): Promise<void> {
  const actor: Actor = { type: 'user', id: self.userId, ...cleanOrigin(origin) }
  const user = await deps.users.findById(scope.environmentId, self.userId)
  const found = user ? await Passwords.ofUser(deps, scope.environmentId, user) : null
  // An account with no address has no password either, and gets the same answer.
  if (user?.emailNormalized === null || (found && found.passwordHash === null)) {
    throw new AuthError('password.not_set')
  }
  // Counted as a failure up front and cleared once the current password checks out, so only
  // wrong guesses add up and parallel guesses can't slip through. Under the step-up's key: it
  // is the same password guessed by the same session, so it gets one budget, not two.
  const lockKey = Mfa.stepUpLockKey(scope.environmentId, self.userId)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  if (!(await Passwords.verify(found?.passwordHash ?? null, input.currentPassword)) || !found) {
    throw new AuthError('auth.invalid_credentials')
  }
  await deps.lockout.clear(lockKey)
  await replacePassword(deps, scope, found.user, input.newPassword, actor, 'self')
  await Sessions.revokeOthers(deps, scope, {
    userId: self.userId,
    currentSessionId: self.sessionId,
    reason: 'password_changed',
    actor,
  })
}
