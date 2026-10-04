import {
  type AccessTokenClaims,
  BACKUP_CODE_COUNT,
  type BackupCodes,
  durationToMs,
  type Factors,
  type SessionTokens,
  STEP_UP_MAX_AGE_SECONDS,
  type StepUpMethod,
  type StepUpRequest,
  type TotpEnrolment,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError, RateLimitError } from '~/exceptions'
import { type Actor, cleanOrigin, type Origin } from '~/lib/actor'
import * as logger from '~/lib/logger'
import { base32Encode, generateSecret, matchStep, otpauthUri } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import { type FactorRecord, isConfirmed, type NewBackupCode } from '~/ports/factor-store'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'

/** Secret-box purpose of sealed TOTP secrets: its own key, apart from signing keys. */
export const TOTP_SECRET_PURPOSE = 'totp-secrets'
/** Keyed-hash purpose of backup codes. */
export const BACKUP_CODE_PURPOSE = 'backup-codes'
/**
 * How long a started enrolment can be confirmed. Long enough to install an app and scan a code;
 * short enough that a secret shown once and abandoned does not linger.
 */
export const PENDING_ENROLMENT_TTL = '10m'
/** Characters in a backup code, before the dash. */
export const BACKUP_CODE_LENGTH = 10
/**
 * Backup-code alphabet: digits and lower-case letters without the ones people confuse
 * (`0`/`o`, `1`/`l`/`i`). 31 characters, so a code holds 10 × log2(31) ≈ 49.5 bits.
 */
export const BACKUP_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/**
 * Lockout key for one user's second-factor guesses in one environment.
 *
 * **One budget for every place a TOTP or backup code is checked**: the second factor of a
 * sign-in or reset, confirming an enrolment and a step-up. Guessing through one route uses up
 * the guesses of all of them.
 *
 * @param environmentId - The environment.
 * @param userId - The user.
 * @returns The key for `deps.lockout`.
 */
export function secondFactorLockKey(environmentId: string, userId: string): string {
  return `second_factor:${environmentId}:${userId}`
}

/**
 * What a sealed TOTP secret is bound to: its environment, its user and its own row. A
 * ciphertext copied to another user's or another environment's row fails to open.
 */
function secretBinding(factor: Pick<FactorRecord, 'environmentId' | 'userId' | 'id'>): string {
  return `${factor.environmentId}:${factor.userId}:${factor.id}`
}

/**
 * A backup code as it is hashed: lower case, without spaces or dashes, so a code typed with or
 * without its dash, in capitals or with stray spaces is the same code.
 *
 * @param code - The code as typed.
 * @returns The normalized code.
 */
export function normalizeBackupCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '')
}

/** The keyed hash of a backup code, bound to its user so a copied row matches nothing. */
function hashBackupCode(
  deps: Pick<Deps, 'keyedHash'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string,
  code: string
): Promise<string> {
  return deps.keyedHash.hmac(
    BACKUP_CODE_PURPOSE,
    `${scope.environmentId}:${userId}:${normalizeBackupCode(code)}`
  )
}

/** One backup code from the CSPRNG, shown as `xxxxx-xxxxx`. */
function randomBackupCode(): string {
  const size = BACKUP_CODE_ALPHABET.length
  // The largest multiple of the alphabet size that fits in a byte: larger bytes are thrown away
  // so every character is equally likely (a plain `% 31` would favour the first eight).
  const limit = 256 - (256 % size)
  let code = ''
  while (code.length < BACKUP_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH * 2))) {
      if (byte < limit && code.length < BACKUP_CODE_LENGTH) {
        code += BACKUP_CODE_ALPHABET[byte % size]
      }
    }
  }
  return `${code.slice(0, BACKUP_CODE_LENGTH / 2)}-${code.slice(BACKUP_CODE_LENGTH / 2)}`
}

/** A fresh set of backup codes: what the user is shown, and what is stored. */
async function newBackupCodes(
  deps: Pick<Deps, 'keyedHash' | 'ids'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<{ codes: string[]; stored: NewBackupCode[] }> {
  // A set, so the ten are distinct (a repeat is astronomically unlikely, but the table's
  // uniqueness on the hash would turn one into a failed request).
  const codes = new Set<string>()
  while (codes.size < BACKUP_CODE_COUNT) {
    codes.add(randomBackupCode())
  }
  const stored = await Promise.all(
    [...codes].map(async (code) => ({
      id: deps.ids.next(),
      codeHash: await hashBackupCode(deps, scope, userId, code),
    }))
  )
  return { codes: [...codes], stored }
}

/**
 * What a signed-in user has enrolled. Never a secret.
 *
 * @param deps - Factor store.
 * @param scope - The environment.
 * @param userId - The signed-in user.
 * @returns Whether an authenticator is confirmed (a pending enrolment does not count), since
 *   when, and how many backup codes are unused.
 */
export async function status(
  deps: Pick<Deps, 'factors'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<Factors> {
  const factor = await deps.factors.findTotp(scope.environmentId, userId)
  const confirmedAt = factor?.confirmedAt ?? null
  return {
    totp: { enabled: confirmedAt !== null, confirmedAt: confirmedAt?.toISOString() ?? null },
    backupCodes: {
      remaining:
        confirmedAt === null ? 0 : await deps.factors.countBackupCodes(scope.environmentId, userId),
    },
  }
}

/**
 * The second factors a user can be asked for: `totp` when an authenticator is confirmed, and
 * `backup_code` while an unused one is left. Empty for a user with no confirmed factor.
 *
 * Independent of the environment's MFA policy on purpose: with the policy `off` a factor a user
 * already has is still asked for. Dropping it silently would be a security regression for that
 * user (ADR 0025).
 *
 * @param deps - Factor store.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The methods, `totp` first.
 */
export async function secondFactors(
  deps: Pick<Deps, 'factors'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<('totp' | 'backup_code')[]> {
  if (!isConfirmed(await deps.factors.findTotp(scope.environmentId, userId))) {
    return []
  }
  const remaining = await deps.factors.countBackupCodes(scope.environmentId, userId)
  return remaining > 0 ? ['totp', 'backup_code'] : ['totp']
}

type EnrolDeps = Pick<
  Deps,
  'factors' | 'users' | 'secretBox' | 'ids' | 'clock' | 'environmentSettings' | 'config'
>

/**
 * Start enrolling an authenticator app: make a secret and store it sealed, pending.
 *
 * The secret is 160 bits from the CSPRNG and is returned **once**, as Base32 and as an
 * `otpauth://` URI naming the environment's app and the user's email. Only the sealed form is
 * stored (AES-256-GCM, bound to environment, user and factor). The pending factor counts for
 * nothing until {@link confirmTotp} proves the app shows the right code, and lapses after
 * {@link PENDING_ENROLMENT_TTL}. Starting again replaces an earlier pending enrolment.
 *
 * @param deps - Factor store, users, secret box, settings, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user enrolling.
 * @returns The secret and its URI.
 * @throws AuthError `mfa.not_available` when the environment's policy is `off`, or
 *   `mfa.already_enabled` when the user already has a confirmed authenticator.
 * @throws NotFoundError when the user does not exist.
 */
export async function startTotp(
  deps: EnrolDeps,
  scope: Scope,
  userId: string
): Promise<TotpEnrolment> {
  const settings = await Settings.current(deps, scope)
  if (settings.mfa.policy === 'off') {
    throw new AuthError('mfa.not_available')
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    throw new NotFoundError()
  }
  const now = deps.clock.now()
  const factor = {
    id: deps.ids.next(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    userId,
    type: 'totp' as const,
    createdAt: now,
    expiresAt: new Date(now.getTime() + durationToMs(PENDING_ENROLMENT_TTL)),
  }
  const secret = generateSecret()
  const sealed = await deps.secretBox.seal(TOTP_SECRET_PURPOSE, secret, secretBinding(factor))
  if (!(await deps.factors.startTotp({ ...factor, secret: sealed }))) {
    throw new AuthError('mfa.already_enabled')
  }
  return {
    secret: base32Encode(secret),
    uri: otpauthUri({ issuer: settings.app.name, account: user.email, secret }),
  }
}

/**
 * Open a factor's sealed secret. A ciphertext that does not open (a row copied from another
 * user or environment, a changed master key, tampering) is treated as a secret nobody knows:
 * no code can match it. The failure is logged without anything about the secret.
 */
async function openSecret(
  deps: Pick<Deps, 'secretBox'>,
  factor: FactorRecord
): Promise<Uint8Array | null> {
  try {
    return await deps.secretBox.open(TOTP_SECRET_PURPOSE, factor.secret, secretBinding(factor))
  } catch {
    logger.warn('a TOTP secret could not be opened', {
      environmentId: factor.environmentId,
      userId: factor.userId,
    })
    return null
  }
}

/** Count one second-factor guess for a user, or refuse while they are locked out. */
async function countGuess(
  deps: Pick<Deps, 'lockout' | 'clock'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<string> {
  const lockKey = secondFactorLockKey(scope.environmentId, userId)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  return lockKey
}

type ConfirmDeps = Pick<
  Deps,
  | 'factors'
  | 'users'
  | 'secretBox'
  | 'keyedHash'
  | 'ids'
  | 'clock'
  | 'lockout'
  | 'sessions'
  | 'revokedSessions'
  | 'signingKeys'
  | 'environments'
  | 'environmentSettings'
  | 'config'
  | 'mailer'
  | 'rateLimiter'
>

/**
 * Confirm a started enrolment with the code the authenticator app shows, turning two-step
 * verification on.
 *
 * In one transaction the factor becomes confirmed, the step of the code that confirmed it is
 * marked used (that code will not also sign anyone in), ten backup codes replace any earlier
 * ones (stored as keyed hashes only) and `user.mfa_enabled` is recorded. Of two concurrent
 * confirmations exactly one succeeds.
 *
 * Then every **other** session of the user ends: they were established without the factor.
 * The session that made the request (if any) is kept and marked as having proven the factor.
 * The owner is emailed (`Notices.mfaChanged`).
 *
 * A wrong code counts against the user's second-factor lockout ({@link secondFactorLockKey}).
 *
 * @param deps - Factor store, crypto, sessions, lockout, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The user, and the session making the request when there is one (an enrolment
 *   inside a sign-in has none).
 * @param code - The 6-digit code.
 * @param actor - The user, for the audit log.
 * @param options - `notify: false` leaves the notice to the caller (an enrolment inside an
 *   attempt announces it only once the attempt has completed).
 * @returns The ten backup codes, shown this once.
 * @throws AuthError `mfa.not_available` when the environment's policy is `off` (checked before
 *   the code is counted: an enrolment started before the switch-off cannot be finished after
 *   it), `mfa.enrolment_expired` when nothing is pending or it lapsed, `mfa.already_enabled`,
 *   or `mfa.invalid_code`.
 * @throws RateLimitError while the user is locked out after repeated wrong codes.
 */
export async function confirmTotp(
  deps: ConfirmDeps,
  scope: Scope,
  self: { userId: string; sessionId?: string },
  code: string,
  actor: Actor,
  options: { notify?: boolean } = {}
): Promise<BackupCodes> {
  const { userId } = self
  const now = deps.clock.now()
  if ((await Settings.current(deps, scope)).mfa.policy === 'off') {
    throw new AuthError('mfa.not_available')
  }
  const [factor, user] = await Promise.all([
    deps.factors.findTotp(scope.environmentId, userId),
    deps.users.findById(scope.environmentId, userId),
  ])
  if (isConfirmed(factor)) {
    throw new AuthError('mfa.already_enabled')
  }
  if (!factor || !user || !factor.expiresAt || factor.expiresAt.getTime() <= now.getTime()) {
    throw new AuthError('mfa.enrolment_expired')
  }
  // Counted as a failure up front and cleared on success, so parallel guesses can't slip by.
  const lockKey = await countGuess(deps, scope, userId)
  const secret = await openSecret(deps, factor)
  const step = secret ? matchStep(secret, code, now) : null
  if (step === null) {
    throw new AuthError('mfa.invalid_code')
  }
  const backup = await newBackupCodes(deps, scope, userId)
  const confirmed = await deps.factors.confirmTotp(scope.environmentId, factor.id, {
    step,
    at: now,
    backupCodes: backup.stored,
    activity: Audit.entry(deps, scope, {
      type: 'user.mfa_enabled',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'totp' },
    }),
  })
  if (!confirmed) {
    // Another request confirmed it first, or it lapsed in between.
    throw new AuthError('mfa.enrolment_expired')
  }
  await deps.lockout.clear(lockKey)
  await (self.sessionId
    ? Sessions.revokeOthers(deps, scope, {
        userId,
        currentSessionId: self.sessionId,
        reason: 'mfa_changed',
        actor,
      })
    : Sessions.revokeAllForUser(deps, scope, userId, 'mfa_changed', actor))
  if (self.sessionId) {
    try {
      // The session that enrolled has just proven the factor.
      await Sessions.recordAuthentication(
        deps,
        scope,
        { userId, sessionId: self.sessionId },
        ['otp', 'mfa'],
        actor
      )
    } catch (error) {
      // Bookkeeping: the factor is on and the codes must still reach the user. The session's
      // next sensitive action asks for a step-up instead.
      logger.warn('could not mark the enrolling session as having proven the factor', {
        environmentId: scope.environmentId,
        err: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  if (options.notify !== false) {
    Notices.mfaChanged(deps, scope, user, { change: 'enabled', at: now })
  }
  return { codes: backup.codes }
}

type ChangeDeps = Pick<
  Deps,
  | 'factors'
  | 'users'
  | 'ids'
  | 'clock'
  | 'lockout'
  | 'environmentSettings'
  | 'config'
  | 'mailer'
  | 'rateLimiter'
>

/** Guesses at a factor that no longer exists must not keep the user out of a new one. */
async function forgetGuesses(
  deps: Pick<Deps, 'lockout'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<void> {
  try {
    await deps.lockout.clear(secondFactorLockKey(scope.environmentId, userId))
  } catch (error) {
    logger.warn('could not clear the second-factor lockout', {
      environmentId: scope.environmentId,
      err: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/**
 * Turn the signed-in user's two-step verification off: remove their authenticator and every
 * backup code, in one transaction with the `user.mfa_disabled` audit entry, and email the
 * owner.
 *
 * Refused while the environment requires a second factor.
 *
 * @param deps - Factor store, users, settings, lockout, notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The signed-in user.
 * @param actor - The user, for the audit log.
 * @throws AuthError `mfa.required_by_policy` when the environment's policy is `required`, or
 *   `mfa.not_enabled` when there is nothing to turn off.
 */
export async function disableTotp(
  deps: ChangeDeps,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<void> {
  if ((await Settings.current(deps, scope)).mfa.policy === 'required') {
    throw new AuthError('mfa.required_by_policy')
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  const removed = await deps.factors.removeForUser(
    scope.environmentId,
    userId,
    Audit.entry(deps, scope, {
      type: 'user.mfa_disabled',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'self' },
    })
  )
  if (!removed || !user) {
    throw new AuthError('mfa.not_enabled')
  }
  await forgetGuesses(deps, scope, userId)
  Notices.mfaChanged(deps, scope, user, { change: 'disabled', at: deps.clock.now() })
}

/**
 * Replace the signed-in user's backup codes with ten new ones. The earlier ones stop working.
 * Recorded (`user.backup_codes_regenerated`) in the same transaction, and the owner is emailed.
 *
 * @param deps - Factor store, users, keyed hash, notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The signed-in user.
 * @param actor - The user, for the audit log.
 * @returns The new codes, shown this once.
 * @throws AuthError `mfa.not_enabled` when the user has no confirmed authenticator.
 */
export async function regenerateBackupCodes(
  deps: ChangeDeps & Pick<Deps, 'keyedHash'>,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<BackupCodes> {
  const user = await deps.users.findById(scope.environmentId, userId)
  const backup = await newBackupCodes(deps, scope, userId)
  const now = deps.clock.now()
  const replaced = await deps.factors.replaceBackupCodes(
    scope.environmentId,
    userId,
    scope,
    backup.stored,
    now,
    Audit.entry(deps, scope, {
      type: 'user.backup_codes_regenerated',
      actor,
      target: { type: 'user', id: userId },
    })
  )
  if (!replaced || !user) {
    throw new AuthError('mfa.not_enabled')
  }
  Notices.mfaChanged(deps, scope, user, { change: 'backup_codes_regenerated', at: now })
  return { codes: backup.codes }
}

/**
 * Reset a user's two-step verification from a server or the dashboard: the recovery path for
 * someone who lost their authenticator **and** their backup codes. There is no other one (no
 * emailed bypass): an inbox alone must never remove a second factor (ADR 0025).
 *
 * The authenticator and every backup code are removed (`user.mfa_disabled`, `method:
 * 'admin_reset'`, with the admin as actor), **every** session of the user ends, and the user is
 * emailed. A user with nothing enrolled still has their sessions ended; nothing else is
 * recorded or sent, since nothing else changed.
 *
 * @param deps - Factor store, users, sessions, denylist, lockout, notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param actor - The admin, for the audit log.
 * @throws NotFoundError when the user does not exist in this environment.
 */
export async function reset(
  deps: ChangeDeps & Pick<Deps, 'sessions' | 'revokedSessions'>,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<void> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    throw new NotFoundError()
  }
  const removed = await deps.factors.removeForUser(
    scope.environmentId,
    userId,
    Audit.entry(deps, scope, {
      type: 'user.mfa_disabled',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'admin_reset' },
    })
  )
  await Sessions.revokeAllForUser(deps, scope, userId, 'mfa_changed', actor)
  await forgetGuesses(deps, scope, userId)
  if (removed) {
    Notices.mfaChanged(deps, scope, user, { change: 'admin_reset', at: deps.clock.now() })
  }
}

/**
 * Check an authenticator code for a user and, if it is right, use its time step up.
 *
 * Right means: the user has a **confirmed** factor (a pending one is never accepted), its
 * secret opens, and the code is the one for the current step or one step either side. A right
 * code is then accepted only if its step is strictly later than the last one used
 * (`FactorStore.useTotpStep`, a compare-and-set): a code works once, and an earlier step's code
 * never works after a later one. Never throws for a wrong code. Counting failures is the
 * caller's job.
 *
 * @param deps - Factor store, secret box and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @param code - What the client submitted.
 * @returns Whether the code proves the factor.
 */
export async function verifyTotp(
  deps: Pick<Deps, 'factors' | 'secretBox' | 'clock'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string,
  code: unknown
): Promise<boolean> {
  const factor = await deps.factors.findTotp(scope.environmentId, userId)
  if (!factor || factor.confirmedAt === null || typeof code !== 'string') {
    return false
  }
  const now = deps.clock.now()
  const secret = await openSecret(deps, factor)
  const step = secret ? matchStep(secret, code, now) : null
  return step !== null && deps.factors.useTotpStep(scope.environmentId, factor.id, step, now)
}

/**
 * Spend a backup code for a user.
 *
 * The code is normalized ({@link normalizeBackupCode}), hashed with the key and the user, and
 * spent in one guarded update together with its `user.backup_code_used` audit entry, so it
 * works exactly once however many requests carry it. The owner is emailed, with how many are
 * left. Never throws for a wrong code. Counting failures is the caller's job.
 *
 * @param deps - Factor store, keyed hash, users, notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user the code must belong to.
 * @param code - What the client submitted.
 * @param actor - The user, with the request's origin, for the audit log.
 * @returns How many unused codes remain, or `null` when the code is not an unused code of this
 *   user.
 */
export async function verifyBackupCode(
  deps: ChangeDeps & Pick<Deps, 'keyedHash'>,
  scope: Scope,
  userId: string,
  code: unknown,
  actor: Actor
): Promise<number | null> {
  if (typeof code !== 'string') {
    return null
  }
  const now = deps.clock.now()
  const remaining = await deps.factors.consumeBackupCode(
    scope.environmentId,
    userId,
    await hashBackupCode(deps, scope, userId, code),
    now,
    Audit.entry(deps, scope, {
      type: 'user.backup_code_used',
      actor,
      target: { type: 'user', id: userId },
    })
  )
  if (remaining === null) {
    return null
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  if (user) {
    Notices.mfaChanged(deps, scope, user, { change: 'backup_code_used', at: now, remaining })
  }
  return remaining
}

/**
 * What a user can step up with: a second factor when they have one (their password alone is
 * then not enough), otherwise their password, otherwise nothing.
 *
 * A user with neither a second factor nor a password (they sign in by email) has no step-up
 * method: for them a "recent authentication" is a recent sign-in (ADR 0025).
 *
 * @param deps - Factor store and users.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The methods `POST /v1/client/sessions/step-up` accepts from this user.
 */
export async function stepUpMethods(
  deps: Pick<Deps, 'factors' | 'users'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<StepUpMethod[]> {
  const second = await secondFactors(deps, scope, userId)
  if (second.length > 0) {
    return second
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  const found = user
    ? await deps.users.findByEmailWithPassword(scope.environmentId, user.emailNormalized)
    : null
  return found?.passwordHash ? ['password'] : []
}

/** The error that asks a client to step up, with what the user can use. */
function stepUpRequired(methods: readonly StepUpMethod[]): AuthError {
  // A string, because error params are scalars: a comma-separated list, possibly empty.
  return new AuthError('auth.step_up_required', { methods: methods.join(',') })
}

/** Options of {@link requireRecentAuthentication}. */
export interface RecentAuthenticationOptions {
  /** How old the session's last proof may be, in seconds. Default ten minutes. */
  maxAgeSeconds?: number
  /**
   * Only demand it from a user who has a second factor. For actions another check already
   * guards for everyone else (changing a password needs the current one).
   */
  onlyWithSecondFactor?: boolean
}

/**
 * Refuse a sensitive action unless the session proved who the user is recently.
 *
 * Reads the verified access token's claims: `auth_time` must be within `maxAgeSeconds`, and for
 * a user who has a second factor `amr` must include `mfa` (the session proved it). The claims
 * are the source of truth: access tokens are verified without a database read and live about a
 * minute, and a step-up returns a fresh one at once. A session that was revoked is stopped by
 * the denylist before this is reached, so a "revoked step-up" needs no handling of its own.
 *
 * @param deps - Factor store, users and clock.
 * @param scope - The environment.
 * @param claims - The verified access-token claims.
 * @param options - The age allowed, and whether only users with a second factor are held to it.
 * @throws AuthError `auth.step_up_required` (403), with `params.methods`: a comma-separated
 *   list of what the user can step up with.
 */
export async function requireRecentAuthentication(
  deps: Pick<Deps, 'factors' | 'users' | 'clock'>,
  scope: Pick<Scope, 'environmentId'>,
  claims: Pick<AccessTokenClaims, 'sub' | 'auth_time' | 'amr'>,
  options: RecentAuthenticationOptions = {}
): Promise<void> {
  const maxAge = options.maxAgeSeconds ?? STEP_UP_MAX_AGE_SECONDS
  const methods = await stepUpMethods(deps, scope, claims.sub)
  const hasSecondFactor = methods.includes('totp')
  if (options.onlyWithSecondFactor && !hasSecondFactor) {
    return
  }
  const now = Math.floor(deps.clock.now().getTime() / 1000)
  const recent = claims.auth_time !== undefined && now - claims.auth_time <= maxAge
  const strong = !hasSecondFactor || (claims.amr ?? []).includes('mfa')
  if (!recent || !strong) {
    throw stepUpRequired(methods)
  }
}

type StepUpDeps = ChangeDeps &
  Pick<Deps, 'keyedHash' | 'secretBox' | 'sessions' | 'signingKeys' | 'environments'>

/**
 * Prove a factor again for the signed-in user's current session (a step-up), and return an
 * access token that says so (`auth_time` now, the method added to `amr`).
 *
 * - A user **with** a second factor must use it (`totp` or `backup_code`). Their password alone
 *   answers `auth.step_up_required`: otherwise a stolen session plus a known password would be
 *   enough for everything the second factor protects.
 * - A user **without** one uses their `password`.
 * - A user with neither has no step-up: `auth.step_up_required` with no methods (they sign in
 *   again).
 *
 * Wrong proofs back off per user (`CREDENTIAL_LOCKOUT`): second-factor codes under the shared
 * {@link secondFactorLockKey}, passwords under a key of their own. A backup code is spent.
 *
 * @param deps - Factor store, users, crypto, sessions, lockout, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param proof - The method and its proof.
 * @param origin - Where the request came from, for the audit log.
 * @returns The session id and a fresh access token. The refresh token is untouched.
 * @throws AuthError `auth.step_up_required` (a method this user may not use),
 *   `auth.invalid_credentials` (wrong password), `mfa.invalid_code` or `session.revoked`.
 * @throws RateLimitError while the user is locked out after repeated wrong proofs.
 */
export async function stepUp(
  deps: StepUpDeps,
  scope: Scope,
  self: { userId: string; sessionId: string },
  proof: StepUpRequest,
  origin: Partial<Origin> = {}
): Promise<SessionTokens> {
  const { userId } = self
  const actor: Actor = { type: 'user', id: userId, ...cleanOrigin(origin) }
  const allowed = await stepUpMethods(deps, scope, userId)
  if (!allowed.includes(proof.method)) {
    throw stepUpRequired(allowed)
  }
  if (proof.method === 'password') {
    const lockKey = `step_up:${scope.environmentId}:${userId}`
    const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
    if (!lock.allowed) {
      throw new RateLimitError(lock.retryAfterMs)
    }
    const user = await deps.users.findById(scope.environmentId, userId)
    const found = user
      ? await deps.users.findByEmailWithPassword(scope.environmentId, user.emailNormalized)
      : null
    if (!(await Passwords.verify(found?.passwordHash ?? null, proof.password)) || !found) {
      throw new AuthError('auth.invalid_credentials')
    }
    await deps.lockout.clear(lockKey)
    return Sessions.recordAuthentication(deps, scope, self, ['pwd'], actor)
  }
  const lockKey = await countGuess(deps, scope, userId)
  const proven =
    proof.method === 'totp'
      ? await verifyTotp(deps, scope, userId, proof.code)
      : (await verifyBackupCode(deps, scope, userId, proof.code, actor)) !== null
  if (!proven) {
    throw new AuthError('mfa.invalid_code')
  }
  await deps.lockout.clear(lockKey)
  return Sessions.recordAuthentication(
    deps,
    scope,
    self,
    [proof.method === 'totp' ? 'otp' : 'backup_code', 'mfa'],
    actor
  )
}
