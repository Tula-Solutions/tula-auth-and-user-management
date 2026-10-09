import {
  type AccessTokenClaims,
  BACKUP_CODE_COUNT,
  type BackupCodes,
  durationToMs,
  type EnvironmentSettings,
  type Factors,
  maskPhoneNumber,
  type PasskeyRequestOptions,
  type SecondFactorMethod,
  type SessionTokens,
  type SmsFactorCode,
  type StepUpEmailCode,
  type StepUpMethod,
  type StepUpRequest,
  stepUpWindowSeconds,
  type TotpEnrolment,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError, RateLimitError } from '~/exceptions'
import { accountLabel } from '~/lib/account-label'
import { type Actor, cleanOrigin, type Origin } from '~/lib/actor'
import * as logger from '~/lib/logger'
import { base32Encode, generateSecret, matchStep, otpauthUri } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as Passkeys from '~/modules/passkey/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Sms from '~/modules/sms/service'
import * as Verification from '~/modules/verification/service'
import { type FactorRecord, isConfirmed, type NewBackupCode } from '~/ports/factor-store'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { isActive } from '~/ports/session-store'
import type { UserRecord } from '~/ports/user-repository'

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
 * The second factors that are **weak**: a texted code, and nothing else.
 *
 * A phone number is the easiest factor to take from someone (a swapped SIM, a recycled
 * number, a message read off a lock screen), so a texted code is ranked below everything
 * else a user can prove second (ADR 0025, "A texted code as the second factor").
 */
const WEAK_SECOND_FACTORS: ReadonlySet<SecondFactorMethod> = new Set(['sms_code'])

/**
 * Whether a second factor is a **strong** one: an authenticator app, a backup code or a
 * passkey. **The one place the order of second factors is stated**; everything that treats a
 * texted code differently asks this, or {@link meetsSecondFactor} which is built on it:
 *
 * - a user who has a strong factor is never offered a weak one ({@link secondFactors});
 * - only a strong factor puts `mfa` into a session's `amr`;
 * - a weak factor can be enrolled only by a user who has no strong one.
 *
 * @param method - A second-factor method.
 * @returns `false` for `sms_code`, `true` for every other method.
 *
 * @example
 * ```ts
 * Mfa.isStrongSecondFactor('totp') // true
 * Mfa.isStrongSecondFactor('sms_code') // false
 * ```
 */
export function isStrongSecondFactor(method: SecondFactorMethod): boolean {
  return !WEAK_SECOND_FACTORS.has(method)
}

/**
 * Whether what a session or an attempt has proven (`amr`) covers the second factor its user
 * is held to.
 *
 * - No second factor in force: yes.
 * - `mfa` in `amr`: yes. Only a strong factor records it ({@link isStrongSecondFactor}).
 * - Otherwise only where **every** factor in force is a weak one (the user's second factor
 *   is a texted code and nothing else): `amr` must then hold `sms` **and something that is
 *   not `sms`**. A texted code to sign in and a texted code as the second step are one phone
 *   proven twice, never two steps.
 *
 * So a texted code never stands in for an authenticator app or a passkey: a user who has
 * either is asked for `mfa`, which a texted code never records.
 *
 * @param amr - What was proven, as `amr` values.
 * @param methods - The second factors in force for the user ({@link secondFactors}).
 * @returns Whether nothing more has to be proven.
 *
 * @example
 * ```ts
 * Mfa.meetsSecondFactor(['pwd', 'sms'], ['sms_code']) // true
 * Mfa.meetsSecondFactor(['sms'], ['sms_code']) // false
 * Mfa.meetsSecondFactor(['pwd', 'sms'], ['totp']) // false
 * ```
 */
export function meetsSecondFactor(
  amr: readonly string[],
  methods: readonly SecondFactorMethod[]
): boolean {
  if (methods.length === 0 || amr.includes('mfa')) {
    return true
  }
  if (methods.some(isStrongSecondFactor)) {
    return false
  }
  return amr.includes('sms') && amr.some((method) => method !== 'sms')
}

/** A user whose second factor a texted code is enrolled as: it is on, with its number. */
type WithSmsFactor = { phoneNumber: string; smsFactorEnabledAt: Date }

/** Whether a texted code is enrolled as a user's second factor: on, with its number. */
function hasSmsFactor<T extends Pick<UserRecord, 'phoneNumber' | 'smsFactorEnabledAt'>>(
  user: T | null
): user is T & WithSmsFactor {
  return user !== null && user.phoneNumber !== null && user.smsFactorEnabledAt !== null
}

/**
 * What a signed-in user has enrolled. Never a secret, and never the phone number.
 *
 * @param deps - Factor store, users, passkeys, settings and the SMS sender.
 * @param scope - The environment.
 * @param userId - The signed-in user.
 * @returns Whether an authenticator is confirmed (a pending enrolment does not count), since
 *   when, how many backup codes are unused, and where a texted code stands: enrolled, in use
 *   (it is what the user is asked for) and whether it could be enrolled now.
 */
export async function status(
  deps: SecondFactorDeps & Pick<Deps, 'sms'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<Factors> {
  const [factor, user, settings] = await Promise.all([
    deps.factors.findTotp(scope.environmentId, userId),
    deps.users.findById(scope.environmentId, userId),
    Settings.current(deps, scope),
  ])
  const confirmedAt = factor?.confirmedAt ?? null
  const enabledAt = hasSmsFactor(user) ? user.smsFactorEnabledAt : null
  const inUse =
    enabledAt !== null && (await secondFactors(deps, scope, userId)).includes('sms_code')
  return {
    totp: { enabled: confirmedAt !== null, confirmedAt: confirmedAt?.toISOString() ?? null },
    backupCodes: {
      remaining:
        confirmedAt === null ? 0 : await deps.factors.countBackupCodes(scope.environmentId, userId),
    },
    sms: {
      enabled: enabledAt !== null,
      enabledAt: enabledAt?.toISOString() ?? null,
      inUse,
      available:
        user !== null &&
        deps.sms.configured &&
        (await smsEnrolmentRefusal(deps, scope, user, settings)) === null &&
        (await smsAllowed(deps, scope, user.phoneNumber)),
    },
  }
}

/** Whether text messages are on for a number's country (`requireSms`, as a boolean). */
async function smsAllowed(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  scope: Pick<Scope, 'environmentId'>,
  phoneNumber: string | null
): Promise<boolean> {
  if (phoneNumber === null) {
    return false
  }
  try {
    await Settings.requireSms(deps, scope, phoneNumber)
    return true
  } catch (error) {
    if (error instanceof AuthError) {
      return false
    }
    throw error
  }
}

/**
 * The second factors a user can be asked for: `totp` when an authenticator is confirmed,
 * `backup_code` while an unused one is left, and `passkey` for a user who has one **and** is
 * held to a second factor anyway (they have an authenticator or a texted code as their second
 * factor, or the environment's policy is `required`). Failing all of those, `sms_code` for a
 * user who made a texted code their second factor. Empty for a user with none of that.
 *
 * **`sms_code` is listed alone or not at all** ({@link isStrongSecondFactor}): a user who has
 * an authenticator app or a usable passkey is asked for that, and their texted code is
 * neither offered nor accepted, at a sign-in, a reset or a step-up. Whoever can read one
 * text message must not get past a factor that was chosen to resist exactly that.
 *
 * Independent of the environment's MFA policy on purpose: with the policy `off` a factor a user
 * already has is still asked for. Dropping it silently would be a security regression for that
 * user (ADR 0025). For the same reason a texted code stays listed when the environment
 * switches `mfa.smsCode` off, or text messages off: the steps that send and accept it then
 * refuse, and the account is closed until the switch is back or an administrator resets it.
 * It never falls open to "no second factor".
 *
 * @param deps - Factor store, users, passkeys and settings.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The methods, `totp` first, `passkey` last; or `['sms_code']`; or none.
 */
export async function secondFactors(
  deps: SecondFactorDeps,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<SecondFactorMethod[]> {
  const totp = isConfirmed(await deps.factors.findTotp(scope.environmentId, userId))
  const settings = await Settings.current(deps, scope)
  const sms = hasSmsFactor(await deps.users.findById(scope.environmentId, userId))
  // A passkey is asked for after a password only where a second factor is in force anyway:
  // the user has an authenticator app or a texted code as their second factor, or the
  // environment requires one. Otherwise adding a passkey for convenience would turn every
  // password sign-in into one that needs the device, with no backup codes behind it
  // (ADR 0027).
  const passkey =
    (totp || sms || settings.mfa.policy === 'required') &&
    (await hasPasskey(deps, scope, userId, settings))
  if (totp) {
    const remaining = await deps.factors.countBackupCodes(scope.environmentId, userId)
    return [
      'totp',
      ...(remaining > 0 ? (['backup_code'] as const) : []),
      ...(passkey ? (['passkey'] as const) : []),
    ]
  }
  if (passkey) {
    return ['passkey']
  }
  // Only here, with nothing stronger: see `isStrongSecondFactor`.
  return sms ? ['sms_code'] : []
}

/** What reading a user's second factors needs. */
export type SecondFactorDeps = Pick<
  Deps,
  'factors' | 'passkeys' | 'users' | 'environmentSettings' | 'config'
>

/** Whether a user has a passkey they could use now: passkeys are on and they have one. */
async function hasPasskey(
  deps: Pick<Deps, 'passkeys'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string,
  settings: EnvironmentSettings
): Promise<boolean> {
  return (
    Passkeys.available(settings) &&
    (await deps.passkeys.listForUser(scope.environmentId, userId)).length > 0
  )
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
    uri: otpauthUri({ issuer: settings.app.name, account: accountLabel(user), secret }),
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
  | 'hooks'
  | 'outbound'
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
 * Every **other** session of the user ends: they were established without the factor. They
 * are ended before the factor is turned on and swept again after, so a failure never leaves
 * the factor on beside a session that did not prove it.
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
 * @returns The ten backup codes, shown this once, and the id of the factor that was confirmed
 *   (for a caller that may have to undo exactly this confirmation; never sent to a client).
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
): Promise<BackupCodes & { factorId: string }> {
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
  // The other sessions end **before** the factor is turned on, and are swept once more after
  // (as a password reset does). If this first sweep fails, nothing has changed: the enrolment
  // is still pending and can be confirmed again. The other order could leave the factor on,
  // sessions that never proved it alive, and the backup codes lost with the failed response.
  const sweep = () =>
    self.sessionId
      ? Sessions.revokeOthers(deps, scope, {
          userId,
          currentSessionId: self.sessionId,
          reason: 'mfa_changed',
          actor,
        })
      : Sessions.revokeAllForUser(deps, scope, userId, 'mfa_changed', actor)
  await sweep()
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
  try {
    // Again, now that the factor is on: a session created between the first sweep and the
    // confirmation must not outlive it. (A sign-in completing after this point checks for the
    // factor itself: see the flow service's `finish`.)
    await sweep()
  } catch (error) {
    // The factor is on and the codes must still reach the user: they are shown once.
    logger.warn('could not sweep the sessions again after turning two-step verification on', {
      environmentId: scope.environmentId,
      err: error instanceof Error ? error.name : 'unknown',
    })
  }
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
  return { codes: backup.codes, factorId: factor.id }
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

/** The purpose of the texted code that makes a texted code a user's second factor. */
export const SMS_FACTOR_ENROLMENT_PURPOSE = 'sms_factor_enrolment'
/** The purpose of the texted code that is the second factor of a sign-in or a reset. */
export const SMS_SECOND_FACTOR_PURPOSE = 'sms_second_factor'
/** The purpose of the texted code a signed-in user steps up with. */
export const SMS_STEP_UP_PURPOSE = 'sms_step_up'

/**
 * What a texted second-factor code's keyed hash also covers: what asked for it (a session, or
 * a flow attempt) and the number it went to. A code then proves that number for that session
 * or attempt and nothing else, even if a row were moved or rewritten, and a number replaced
 * while its code was on its way proves nothing.
 */
function smsCodeBinding(askedBy: string, phoneNumber: string): string {
  return `${askedBy}:${phoneNumber}`
}

/** What every step that sends or accepts a texted second-factor code asks first. */
type SmsFactorGateDeps = Pick<Deps, 'environmentSettings' | 'config' | 'sms'>

/**
 * Refuse a step of the texted second factor where it cannot be used now: **every** step that
 * sends such a code or accepts one calls this first, before anything is counted, spent or
 * sent (ADR 0025).
 *
 * In order: the environment's own switch (`mfa.smsCode`), then what any text message needs
 * (`Settings.requireSms` for the number: text messages on, the number's country allowed),
 * then a sender (`Sms.requireSender`). A code asked for before any of them changed is not
 * honoured after.
 *
 * @param deps - Settings and the SMS sender.
 * @param scope - The environment.
 * @param phoneNumber - The account's number, in E.164 form.
 * @throws AuthError `auth.method_disabled` (the switch is off), `sms.disabled`,
 *   `sms.country_not_allowed` or `sms.unavailable`.
 */
export async function requireSmsFactor(
  deps: SmsFactorGateDeps,
  scope: Pick<Scope, 'environmentId'>,
  phoneNumber: string
): Promise<void> {
  if (!(await Settings.current(deps, scope)).mfa.smsCode.enabled) {
    throw new AuthError('auth.method_disabled')
  }
  await Settings.requireSms(deps, scope, phoneNumber)
  Sms.requireSender(deps, scope)
}

type SmsCodeDeps = SmsFactorGateDeps &
  Pick<
    Deps,
    'clock' | 'ids' | 'keyedHash' | 'verificationTokens' | 'mailer' | 'smsUsage' | 'rateLimiter'
  >

/** Where a request for a texted code came from, for the send limits. */
export interface SmsSource {
  /** The request's address as the per-IP limits read it; `null` for a call no request made. */
  address?: string | null
}

/**
 * Text a 6-digit second-factor code to a user's own number and store its token.
 *
 * The one place a texted second-factor code is issued, for all three uses (an enrolment, a
 * sign-in's or reset's second factor, a step-up). The message goes through `Sms.sendCode`
 * and nowhere else, so every send limit and the day's limit apply, counted for an asker of
 * its own (`second_factor`, the user's id) and never as a new number. **The send is waited
 * for**: unlike a sign-in's first factor there is nothing to hide (the caller has proven who
 * the user is), so a message that could not be sent is said honestly (`sms.unavailable`).
 * The token is stored only after the sender took the message: a failed or refused send
 * leaves an earlier code working.
 *
 * @param deps - Settings, the SMS sender and its counts, the token store, ids and clock.
 * @param scope - The project and environment.
 * @param input - The purpose, the user and their number, what asked (for the binding and the
 *   token's subject) and the request's address.
 * @returns The masked number and when the code expires. Never the code or the number.
 * @throws AuthError `auth.method_disabled`, `sms.disabled`, `sms.country_not_allowed` or
 *   `sms.unavailable`.
 * @throws RateLimitError when a send limit, or the environment's daily limit, is spent.
 */
export async function textSecondFactorCode(
  deps: SmsCodeDeps,
  scope: Scope,
  input: {
    purpose:
      | typeof SMS_FACTOR_ENROLMENT_PURPOSE
      | typeof SMS_SECOND_FACTOR_PURPOSE
      | typeof SMS_STEP_UP_PURPOSE
    userId: string
    phoneNumber: string
    /** The session or the flow attempt that asks. */
    askedBy: { sessionId: string } | { flowAttemptId: string }
    address?: string | null
  }
): Promise<SmsFactorCode> {
  await requireSmsFactor(deps, scope, input.phoneNumber)
  const attempt = 'flowAttemptId' in input.askedBy ? input.askedBy.flowAttemptId : undefined
  const issued = await Verification.issue(deps, scope, {
    purpose: input.purpose,
    destination: input.phoneNumber,
    // A sign-in's code is its attempt's; the others are the signed-in user's.
    ...(attempt === undefined ? { userId: input.userId } : { flowAttemptId: attempt }),
    binding: smsCodeBinding(
      'sessionId' in input.askedBy ? input.askedBy.sessionId : input.askedBy.flowAttemptId,
      input.phoneNumber
    ),
    sendLimits: Verification.LIMITED_BY_DELIVERY,
    deliver: ({ code }) =>
      Sms.sendCode(deps, scope, {
        to: input.phoneNumber,
        code,
        asker: { type: 'second_factor', id: input.userId },
        newNumber: false,
        address: input.address ?? null,
      }),
  })
  return {
    method: 'sms_code',
    destination: maskPhoneNumber(input.phoneNumber),
    expiresAt: issued.expiresAt.toISOString(),
  }
}

/**
 * Check a texted code as a user's second factor (a sign-in, a reset or a step-up), and spend
 * it.
 *
 * Right means: a texted code **is** the user's second factor and nothing stronger is in
 * force ({@link secondFactors} lists `sms_code`); the code is the newest one of that purpose
 * for what asked (the attempt, or the user), unspent and unexpired; and it was texted to the
 * number the account holds **now**. Never throws for a wrong code: a wrong, used, expired,
 * replaced or out-of-guesses code, another attempt's or another session's, and one of another
 * purpose are all `false`. Counting the guess is the caller's job, before this is called.
 *
 * @param deps - Factor store, users, settings, token store, the SMS counts and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @param proof - The purpose, what asked for the code, and the code as submitted.
 * @returns Whether the code proves the factor.
 */
export async function verifySmsCode(
  deps: SecondFactorDeps & Pick<Deps, 'clock' | 'keyedHash' | 'verificationTokens' | 'smsUsage'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string,
  proof: {
    purpose: typeof SMS_SECOND_FACTOR_PURPOSE | typeof SMS_STEP_UP_PURPOSE
    askedBy: { sessionId: string } | { flowAttemptId: string }
    code: unknown
  }
): Promise<boolean> {
  if (typeof proof.code !== 'string') {
    return false
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!hasSmsFactor(user) || !(await secondFactors(deps, scope, userId)).includes('sms_code')) {
    return false
  }
  const bySession = 'sessionId' in proof.askedBy
  try {
    const token = await Verification.verifyCode(deps, scope, {
      purpose: proof.purpose,
      subject:
        'sessionId' in proof.askedBy ? { userId } : { flowAttemptId: proof.askedBy.flowAttemptId },
      code: proof.code,
      binding: smsCodeBinding(
        'sessionId' in proof.askedBy ? proof.askedBy.sessionId : proof.askedBy.flowAttemptId,
        user.phoneNumber
      ),
    })
    if (token.destination !== user.phoneNumber || (bySession && token.userId !== userId)) {
      return false
    }
    await Sms.recordUsed(deps, scope, { to: user.phoneNumber, sentAt: token.createdAt })
    return true
  } catch (error) {
    if (error instanceof AuthError && error.code.startsWith('verification.')) {
      return false
    }
    throw error
  }
}

/**
 * Why a user cannot make a texted code their second factor now, or `null` when they can.
 *
 * In order: the environment offers no second factor at all, or not this one
 * (`mfa.not_available`); the account has no proven phone number
 * (`mfa.phone_number_required`); it is on already (`mfa.already_enabled`); the user has an
 * authenticator app or a passkey they can use (`mfa.sms_not_allowed`: a texted code is never
 * added beside a stronger factor, where it could only ever be the weakest way in).
 */
async function smsEnrolmentRefusal(
  deps: Pick<Deps, 'factors' | 'passkeys'>,
  scope: Pick<Scope, 'environmentId'>,
  user: Pick<UserRecord, 'id' | 'phoneNumber' | 'smsFactorEnabledAt'>,
  settings: EnvironmentSettings
): Promise<
  | 'mfa.not_available'
  | 'mfa.phone_number_required'
  | 'mfa.already_enabled'
  | 'mfa.sms_not_allowed'
  | null
> {
  if (settings.mfa.policy === 'off' || !settings.mfa.smsCode.enabled) {
    return 'mfa.not_available'
  }
  if (user.phoneNumber === null) {
    return 'mfa.phone_number_required'
  }
  if (user.smsFactorEnabledAt !== null) {
    return 'mfa.already_enabled'
  }
  const totp = isConfirmed(await deps.factors.findTotp(scope.environmentId, user.id))
  if (totp || (await hasPasskey(deps, scope, user.id, settings))) {
    return 'mfa.sms_not_allowed'
  }
  return null
}

/** The user and their number, for a step of the texted-code enrolment; or the refusal. */
async function smsEnrolmentUser(
  deps: Pick<Deps, 'factors' | 'passkeys' | 'users' | 'environmentSettings' | 'config'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<UserRecord & { phoneNumber: string }> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    throw new NotFoundError()
  }
  const refusal = await smsEnrolmentRefusal(deps, scope, user, await Settings.current(deps, scope))
  if (refusal !== null || user.phoneNumber === null) {
    throw new AuthError(refusal ?? 'mfa.phone_number_required')
  }
  return { ...user, phoneNumber: user.phoneNumber }
}

/**
 * Start making a texted code the signed-in user's second factor: text a code to **the
 * account's own, already proven, phone number**.
 *
 * The number is never taken from the request: it is the one the account holds
 * (`Phone.verify` put it there). It is proven again here, with a fresh code of a purpose of
 * its own (`sms_factor_enrolment`, bound to the asking session and the number), so that a
 * number proven long ago by someone who has since lost it cannot become a factor unseen.
 *
 * @param deps - Factor store, users, passkeys, settings, the SMS sender, token store, ids
 *   and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session.
 * @param source - The request's address, for the send limits.
 * @returns The masked number and when the code expires. Never the code.
 * @throws AuthError `mfa.not_available` (the policy is `off`, or the environment does not
 *   offer a texted code), `mfa.phone_number_required`, `mfa.already_enabled`,
 *   `mfa.sms_not_allowed` (the user has an authenticator app or a passkey), `sms.disabled`,
 *   `sms.country_not_allowed` or `sms.unavailable`.
 * @throws NotFoundError when the user does not exist.
 * @throws RateLimitError when a send limit, or the environment's daily limit, is spent.
 */
export async function startSms(
  deps: SmsCodeDeps & Pick<Deps, 'factors' | 'passkeys' | 'users'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  source: SmsSource = {}
): Promise<SmsFactorCode> {
  const user = await smsEnrolmentUser(deps, scope, self.userId)
  return textSecondFactorCode(deps, scope, {
    purpose: SMS_FACTOR_ENROLMENT_PURPOSE,
    userId: user.id,
    phoneNumber: user.phoneNumber,
    askedBy: { sessionId: self.sessionId },
    address: source.address,
  })
}

/**
 * Confirm the texted code, making a texted code the signed-in user's second factor.
 *
 * In order, and nothing is counted or spent by a refusal before step 3:
 * 1. everything {@link startSms} checks, again (an enrolment started before the environment
 *    switched it off, or before the user gained a stronger factor, is not finished after),
 *    and {@link requireSmsFactor} for the number;
 * 2. a code must be pending for this user (`mfa.enrolment_expired` otherwise);
 * 3. the guess is counted under the user's second-factor lockout
 *    ({@link secondFactorLockKey}), **before** the code is looked at;
 * 4. the code is checked against the newest `sms_factor_enrolment` token of this user, with
 *    the binding of this session and the account's number, and spent;
 * 5. every **other** session of the user ends (they were established without the factor),
 *    before the factor is turned on and once more after, as for an authenticator;
 * 6. the factor is turned on with a compare-and-set on the number the code was texted to
 *    (`users.enableSmsFactor`), with `user.sms_factor_enabled` in the same transaction;
 * 7. the session that enrolled is marked as having proven it (`sms` in `amr`: **never**
 *    `mfa`, which only a strong factor records), and the owner is emailed.
 *
 * There are no backup codes: the way back for someone who lost the number is an
 * administrator's reset.
 *
 * @param deps - Factor store, users, sessions, lockout, token store, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session.
 * @param code - The 6-digit code.
 * @param actor - The user, for the audit log.
 * @returns What the user now has enrolled.
 * @throws AuthError what {@link startSms} throws, `auth.method_disabled`,
 *   `mfa.enrolment_expired` (no code pending, or the number changed meanwhile) or
 *   `mfa.invalid_code`.
 * @throws RateLimitError while the user is locked out after repeated wrong codes.
 */
export async function confirmSms(
  deps: ConfirmDeps & Pick<Deps, 'passkeys' | 'verificationTokens' | 'sms' | 'smsUsage'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  code: string,
  actor: Actor
): Promise<Factors> {
  const { userId } = self
  const user = await smsEnrolmentUser(deps, scope, userId)
  await requireSmsFactor(deps, scope, user.phoneNumber)
  const now = deps.clock.now()
  const pending = await deps.verificationTokens.findLatest(
    scope.environmentId,
    SMS_FACTOR_ENROLMENT_PURPOSE,
    { userId }
  )
  if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= now.getTime()) {
    // Nothing is pending: there is no code to guess at, so nothing is counted.
    throw new AuthError('mfa.enrolment_expired')
  }
  const lockKey = await countGuess(deps, scope, userId)
  let token: Awaited<ReturnType<typeof Verification.verifyCode>>
  try {
    token = await Verification.verifyCode(deps, scope, {
      purpose: SMS_FACTOR_ENROLMENT_PURPOSE,
      subject: { userId },
      code,
      binding: smsCodeBinding(self.sessionId, user.phoneNumber),
    })
  } catch (error) {
    if (error instanceof AuthError && error.code.startsWith('verification.')) {
      // Wrong, another session's, out of guesses, or for a number that has been replaced.
      throw new AuthError('mfa.invalid_code')
    }
    throw error
  }
  const sweep = () =>
    Sessions.revokeOthers(deps, scope, {
      userId,
      currentSessionId: self.sessionId,
      reason: 'mfa_changed',
      actor,
    })
  // Before the factor is on, and once more after: see `confirmTotp`.
  await sweep()
  const enabled = await deps.users.enableSmsFactor(
    scope.environmentId,
    userId,
    token.destination,
    now,
    Audit.entry(deps, scope, {
      type: 'user.sms_factor_enabled',
      actor,
      target: { type: 'user', id: userId },
    })
  )
  if (!enabled) {
    // The number was replaced or removed, or another request turned it on first.
    throw new AuthError('mfa.enrolment_expired')
  }
  await deps.lockout.clear(lockKey)
  try {
    await sweep()
  } catch (error) {
    logger.warn('could not sweep the sessions again after turning a texted second factor on', {
      environmentId: scope.environmentId,
      err: error instanceof Error ? error.name : 'unknown',
    })
  }
  try {
    // The session that enrolled has just proven the factor. `sms`, never `mfa`.
    await Sessions.recordAuthentication(deps, scope, self, ['sms'], actor)
  } catch (error) {
    // Bookkeeping: the session's next sensitive action asks for a step-up instead.
    logger.warn('could not mark the enrolling session as having proven the texted factor', {
      environmentId: scope.environmentId,
      err: error instanceof Error ? error.name : 'unknown',
    })
  }
  await Sms.recordUsed(deps, scope, { to: token.destination, sentAt: token.createdAt })
  Notices.mfaChanged(deps, scope, user, { change: 'sms_enabled', at: now })
  return status(deps, scope, userId)
}

/**
 * Stop a texted code being the signed-in user's second factor. The phone number stays on the
 * account. Recorded (`user.sms_factor_removed`, `self`) in the same transaction, and the
 * owner is emailed.
 *
 * Refused while the environment requires a second factor **and** the texted code is the one
 * the user is held to. Beside an authenticator app or a passkey it is unused, and may always
 * be removed.
 *
 * @param deps - Factor store, users, passkeys, settings, lockout, notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The signed-in user.
 * @param actor - The user, for the audit log.
 * @throws AuthError `mfa.required_by_policy`, or `mfa.not_enabled` when there is nothing to
 *   turn off.
 */
export async function disableSms(
  deps: ChangeDeps & Pick<Deps, 'passkeys'>,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<void> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!hasSmsFactor(user)) {
    throw new AuthError('mfa.not_enabled')
  }
  const inUse = (await secondFactors(deps, scope, userId)).includes('sms_code')
  if (inUse && (await Settings.current(deps, scope)).mfa.policy === 'required') {
    throw new AuthError('mfa.required_by_policy')
  }
  const removed = await deps.users.disableSmsFactor(
    scope.environmentId,
    userId,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.sms_factor_removed',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'self' },
    })
  )
  if (!removed) {
    throw new AuthError('mfa.not_enabled')
  }
  if (inUse) {
    await forgetGuesses(deps, scope, userId)
  }
  Notices.mfaChanged(deps, scope, user, { change: 'sms_removed', at: deps.clock.now() })
}

/**
 * Reset a user's two-step verification from a server or the dashboard: the recovery path for
 * someone who lost their authenticator **and** their backup codes. There is no other one (no
 * emailed bypass): an inbox alone must never remove a second factor (ADR 0025).
 *
 * The authenticator and every backup code are removed (`user.mfa_disabled`, `method:
 * 'admin_reset'`, with the admin as actor), and so is a texted code as the second factor
 * (`user.sms_factor_removed`, `admin_reset`; the phone number itself stays on the account),
 * **every** session of the user ends, and the user is emailed. A user with nothing enrolled still has their sessions ended; nothing else is
 * recorded or sent, since nothing else changed.
 *
 * **Passkeys go too, even one that was the account's only way in** (ADR 0027): this is the
 * "this account's authenticators are gone" tool, so unlike the owner's own removal it is never
 * refused. What it does instead is say so: the answer is whether the user can still sign in
 * with what is left, by the one rule the owner's removal uses (`OAuth.canStillSignIn`), and the
 * `user.passkey_removed` entry records the same boolean. `false` means the admin has to give
 * the account a way in (the user's "Forgot password" where the password method is on).
 *
 * @param deps - Factor store, passkeys, users, provider store, sessions, denylist, lockout,
 *   notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param actor - The admin, for the audit log.
 * @returns Whether the user can still sign in with what they have left.
 * @throws NotFoundError when the user does not exist in this environment.
 */
export async function reset(
  deps: ChangeDeps & Pick<Deps, 'sessions' | 'revokedSessions' | 'passkeys' | 'oauthProviders'>,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<{ canStillSignIn: boolean }> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    throw new NotFoundError()
  }
  // Worked out before anything is removed, so that the audit entry written with the removal
  // can carry it: what is left is everything the user has now, less every passkey.
  // It is the answer as of the start of the reset: a password or provider changed by someone
  // else in the same moment is not reflected, which an admin resetting the account can live with.
  const withPassword = await Passwords.ofUser(deps, scope.environmentId, user)
  const canStillSignIn = OAuth.canStillSignIn(
    await Settings.current(deps, scope),
    await OAuth.enabledProviders(deps, scope),
    {
      hasPassword: Boolean(withPassword?.passwordHash),
      emailVerified: user.emailVerifiedAt !== null,
      providers: (await deps.users.listIdentities(scope.environmentId, userId)).map(
        (identity) => identity.provider
      ),
      passkeys: 0,
    }
  )
  // Sessions first, then the factor. If ending the sessions fails, the factor still guards
  // the account and the reset can simply be repeated; the other order could leave the factor
  // gone while a possibly stolen session lives on. Both steps are idempotent.
  await Sessions.revokeAllForUser(deps, scope, userId, 'mfa_changed', actor)
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
  // Passkeys go with it: the reset is the "this account's authenticators are gone" tool, and
  // a lost or stolen device is as likely to hold the passkey as the authenticator app.
  const passkeys = await deps.passkeys.removeForUser(
    scope.environmentId,
    userId,
    Audit.entry(deps, scope, {
      type: 'user.passkey_removed',
      actor,
      target: { type: 'user', id: userId },
      // A boolean and nothing else: never which methods remain, nor an address.
      data: { method: 'admin_reset', canStillSignIn },
    })
  )
  // A texted code as the second factor goes too. The number stays: it is contact data, and
  // taking it is not what "reset two-step verification" says.
  const sms = await deps.users.disableSmsFactor(
    scope.environmentId,
    userId,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.sms_factor_removed',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'admin_reset' },
    })
  )
  // Once more: a sign-in that completed with the factor between the two steps is ended too.
  await Sessions.revokeAllForUser(deps, scope, userId, 'mfa_changed', actor)
  await forgetGuesses(deps, scope, userId)
  if (removed || passkeys > 0 || sms) {
    Notices.mfaChanged(deps, scope, user, { change: 'admin_reset', at: deps.clock.now() })
  }
  return { canStillSignIn }
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
 * Step-up codes one user may be emailed in an hour. Counted per user, apart from the
 * per-address limits of the codes that can be asked for without signing in.
 */
export const STEP_UP_EMAILS_PER_HOUR = 5

/**
 * The lockout key of a step-up by a user who has no second factor: their password and their
 * emailed code share it, so guessing one uses up the guesses at the other.
 *
 * It is the one budget for **every guess at the password by someone who already holds a
 * session**: the current password of `Users.changePassword` counts here too. With a key of its
 * own that route would hand a stolen session a second set of guesses at the same secret
 * (ADR 0011). A sign-in's guesses stay per identifier (`signInLockKey`): they come from
 * someone who holds no session, and must not lock the signed-in owner out of a step-up.
 *
 * Kept apart from {@link secondFactorLockKey}: a second factor's budget must not be spent by
 * someone guessing at a weaker method.
 *
 * @param environmentId - The environment.
 * @param userId - The signed-in user.
 * @returns The key for `deps.lockout`. Ids only: lockout keys may live in Redis.
 */
export function stepUpLockKey(environmentId: string, userId: string): string {
  return `step_up:${environmentId}:${userId}`
}

/**
 * What a user can step up with: a second factor when they have one (nothing weaker is then
 * enough; a passkey is one of them for such a user; `sms_code` is the list, alone, for a user
 * whose only second factor is a texted code, and is never in it beside an authenticator app
 * or a passkey: {@link secondFactors}), otherwise a passkey when they have one,
 * their password when they have one and a code emailed to their verified address
 * (`email_code`), otherwise nothing.
 *
 * `email_code` is never offered next to a second factor. For a user without one it adds no
 * way in that their mailbox does not already give (a password reset, an emailed sign-in), and
 * it is what lets someone who signed up through a provider or by email, and so has no
 * password, change how their account is protected (ADR 0025).
 *
 * @param deps - Factor store and users.
 * @param scope - The environment.
 * @param userId - The user.
 * @returns The methods `POST /v1/client/sessions/step-up` accepts from this user.
 */
export async function stepUpMethods(
  deps: SecondFactorDeps,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<StepUpMethod[]> {
  return (await stepUpState(deps, scope, userId)).methods
}

/** What a user can step up with, and whether a second factor is what they must use. */
async function stepUpState(
  deps: SecondFactorDeps,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<{ methods: StepUpMethod[]; second: SecondFactorMethod[] }> {
  const second = await secondFactors(deps, scope, userId)
  if (second.length > 0) {
    // What a sign-in asks this user for is what a step-up asks them for. So `sms_code` is
    // here exactly when it is the user's only second factor, and never beside a stronger one.
    return { methods: second, second }
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    return { methods: [], second }
  }
  const found = await Passwords.ofUser(deps, scope.environmentId, user)
  const passkey = await hasPasskey(deps, scope, userId, await Settings.current(deps, scope))
  return {
    methods: [
      ...(passkey ? (['passkey'] as const) : []),
      ...(found?.passwordHash ? (['password'] as const) : []),
      ...(user.emailVerifiedAt ? (['email_code'] as const) : []),
    ],
    second,
  }
}

/** The error that asks a client to step up, with what the user can use. */
function stepUpRequired(methods: readonly StepUpMethod[]): AuthError {
  // A string, because error params are scalars: a comma-separated list, possibly empty.
  return new AuthError('auth.step_up_required', { methods: methods.join(',') })
}

/** Options of {@link requireRecentAuthentication}. */
export interface RecentAuthenticationOptions {
  /**
   * How old the session's last proof may be, in seconds. Default: the `stepUpAfter` of the
   * session's profile, or ten minutes (`STEP_UP_MAX_AGE_SECONDS`) when it sets none.
   */
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
 * Reads the session's claims: `auth_time` must be within the window (the profile's
 * `stepUpAfter`, see {@link RecentAuthenticationOptions}), for
 * a user who has a second factor the session must have proven it ({@link meetsSecondFactor}:
 * `mfa` in `amr`, which a texted code never records; or, for a user whose only second factor
 * is a texted code, `sms` beside something else), and `amr`
 * must hold something other than `sms`: a sign-in with a texted code alone never counts,
 * and the user steps up with a password, an emailed code or a passkey first. The claims
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
  deps: SecondFactorDeps & Pick<Deps, 'clock'>,
  scope: Pick<Scope, 'environmentId'>,
  claims: Pick<AccessTokenClaims, 'sub' | 'auth_time' | 'amr' | 'sp'>,
  options: RecentAuthenticationOptions = {}
): Promise<void> {
  // The window of the session's profile, as configured now; a route may fix its own.
  const maxAge =
    options.maxAgeSeconds ??
    stepUpWindowSeconds((await Settings.current(deps, scope)).sessions, claims.sp)
  const { methods, second } = await stepUpState(deps, scope, claims.sub)
  if (options.onlyWithSecondFactor && second.length === 0) {
    return
  }
  const now = Math.floor(deps.clock.now().getTime() / 1000)
  const recent = claims.auth_time !== undefined && now - claims.auth_time <= maxAge
  const amr = claims.amr ?? []
  // A session that has proven nothing but a texted code is never "recently authenticated"
  // for a sensitive change, however fresh it is (ADR 0037): a phone number is the easiest
  // factor to take, and must not be what adds a passkey, an authenticator or another number
  // to an account. Such a user steps up with what `stepUpMethods` lists. That is a texted
  // code only for a user who made one their second factor, and then the session must have
  // proven something else as well.
  const smsAlone = amr.length > 0 && amr.every((method) => method === 'sms')
  const strong = meetsSecondFactor(amr, second) && !smsAlone
  if (!recent || !strong) {
    throw stepUpRequired(methods)
  }
}

type StepUpDeps = ChangeDeps &
  Pick<
    Deps,
    | 'keyedHash'
    | 'secretBox'
    | 'sessions'
    | 'signingKeys'
    | 'hooks'
    | 'outbound'
    | 'environments'
    | 'verificationTokens'
    | 'passkeys'
    | 'sms'
    | 'smsUsage'
  >

/**
 * Email the signed-in user a 6-digit code to step up with (`email_code`).
 *
 * Only for a user with a verified address and no second factor ({@link stepUpMethods}); anyone
 * else gets `auth.step_up_required` with what they can use, and nothing is sent. The code is
 * a verification token of purpose `step_up` (never honoured for another purpose, nor another
 * purpose's for this), stored as a keyed hash that also covers the asking session's id: a code
 * asked for by one session steps up no other. It carries no link.
 *
 * Sends are limited per user and under keys no other email uses: one a minute
 * (`step_up_email_cooldown:<environment>:<user>`) and {@link STEP_UP_EMAILS_PER_HOUR} an hour
 * (`step_up_email:<environment>:<user>`). They are deliberately **not** the per-address limits
 * of the sign-in, reset and verification codes: those can be asked for without signing in, so
 * sharing them would let anyone who knows the address keep this user's step-up refused. Nor do
 * step-up sends use up that address budget.
 *
 * @param deps - Factor store, users, verification tokens, mailer, rate limiter, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param _request - The method asked for; `email_code` is the only one that needs preparing.
 * @returns The masked destination and when the code expires. Never the code.
 * @throws AuthError `auth.step_up_required` when this user may not step up by email.
 * @throws RateLimitError when a code was sent too recently or too often.
 * @throws ServiceUnavailableError when the rate limiter cannot answer (nothing is sent).
 * @throws InternalError when the email could not be sent (the earlier code keeps working).
 */
export async function prepareStepUp(
  deps: Pick<
    Deps,
    | 'factors'
    | 'passkeys'
    | 'users'
    | 'clock'
    | 'ids'
    | 'keyedHash'
    | 'verificationTokens'
    | 'mailer'
    | 'rateLimiter'
    | 'environmentSettings'
    | 'config'
  >,
  scope: Scope,
  self: { userId: string; sessionId: string },
  _request: { method: 'email_code' }
): Promise<StepUpEmailCode> {
  const allowed = await stepUpMethods(deps, scope, self.userId)
  const user = await deps.users.findById(scope.environmentId, self.userId)
  // `email_code` is listed only for a verified address, so an account with none never gets
  // here; the address is asked for again because this is where it is sent to.
  if (!allowed.includes('email_code') || !user || user.email === null) {
    throw stepUpRequired(allowed)
  }
  const issued = await Verification.issue(deps, scope, {
    purpose: 'step_up',
    destination: user.email,
    userId: user.id,
    binding: self.sessionId,
    // Its own limits, per user: the address's are shared with codes a stranger can ask for
    // (sign-in, reset), who could otherwise keep this user's step-up refused.
    sendLimits: {
      name: 'step_up_email',
      subject: `${scope.environmentId}:${user.id}`,
      perHour: STEP_UP_EMAILS_PER_HOUR,
    },
  })
  return {
    method: 'email_code',
    destination: issued.destination,
    expiresAt: issued.expiresAt.toISOString(),
  }
}

/**
 * Start a step-up by passkey: the options for `navigator.credentials.get()`, naming the user's
 * own passkeys. The challenge is stored for the asking session only (five minutes, one use;
 * asking again replaces it).
 *
 * @param deps - Factor store, passkey store, users, settings, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param origin - The request's `Origin`.
 * @returns `PublicKeyCredentialRequestOptionsJSON`.
 * @throws AuthError `auth.method_disabled`, `request.origin_not_allowed`, or
 *   `auth.step_up_required` (with what the user can use) for a user who has no passkey.
 */
export async function prepareStepUpPasskey(
  deps: SecondFactorDeps & Pick<Deps, 'ids' | 'clock'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  origin: string | null | undefined
): Promise<PasskeyRequestOptions> {
  const rp = await Passkeys.relyingParty(deps, scope, origin)
  const allowed = await stepUpMethods(deps, scope, self.userId)
  if (!allowed.includes('passkey')) {
    throw stepUpRequired(allowed)
  }
  const owned = await deps.passkeys.listForUser(scope.environmentId, self.userId)
  const challenge = await Passkeys.issueChallenge(deps, scope, self, 'step_up')
  return Passkeys.requestOptions(rp, challenge, owned)
}

/**
 * Text the signed-in user a 6-digit code to step up with (`sms_code`).
 *
 * **Only for a user whose only second factor is a texted code** ({@link stepUpMethods}).
 * Anyone else gets `auth.step_up_required` with what they can use, and nothing is sent: a
 * user with an authenticator app or a passkey never steps up with a text message, and a user
 * with no second factor steps up with their password or an emailed code, never with their
 * phone. The code is a verification token of purpose `sms_step_up` (honoured for nothing
 * else), stored as a keyed hash that also covers the asking session and the number.
 *
 * @param deps - Factor store, users, passkeys, settings, the SMS sender, token store, ids
 *   and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param source - The request's address, for the send limits.
 * @returns The masked number and when the code expires. Never the code.
 * @throws AuthError `auth.step_up_required` when this user may not step up by text message,
 *   `auth.method_disabled`, `sms.disabled`, `sms.country_not_allowed` or `sms.unavailable`.
 * @throws RateLimitError when a send limit, or the environment's daily limit, is spent.
 */
export async function prepareStepUpSms(
  deps: SmsCodeDeps & SecondFactorDeps,
  scope: Scope,
  self: { userId: string; sessionId: string },
  source: SmsSource = {}
): Promise<SmsFactorCode> {
  const allowed = await stepUpMethods(deps, scope, self.userId)
  const user = await deps.users.findById(scope.environmentId, self.userId)
  if (!allowed.includes('sms_code') || !hasSmsFactor(user)) {
    throw stepUpRequired(allowed)
  }
  return textSecondFactorCode(deps, scope, {
    purpose: SMS_STEP_UP_PURPOSE,
    userId: self.userId,
    phoneNumber: user.phoneNumber,
    askedBy: { sessionId: self.sessionId },
    address: source.address,
  })
}

/**
 * Prove a factor again for the signed-in user's current session (a step-up), and return an
 * access token that says so (`auth_time` now, the method added to `amr`).
 *
 * - A user **with** a second factor must use it (`totp` or `backup_code`). Their password alone
 *   answers `auth.step_up_required`: otherwise a stolen session plus a known password would be
 *   enough for everything the second factor protects.
 * - A user **without** one uses their `password`, or an `email_code` this session asked for
 *   with {@link prepareStepUp} (recorded as `email` in `amr`, like the email first factor).
 * - A user whose **only** second factor is a texted code uses the `sms_code` this session
 *   asked for with {@link prepareStepUpSms}. It is recorded as `sms` and **never** as `mfa`.
 *   Beside an authenticator app or a passkey it is not a method at all.
 * - A user with a **passkey** may always use it (`passkey`, after
 *   {@link prepareStepUpPasskey}): it is recorded as `hwk` or `swk`, `user` and `mfa`, since
 *   it is possession and a verified user in one step. A wrong assertion is the generic
 *   `auth.invalid_credentials`.
 * - A user with neither a password nor a verified address has no step-up:
 *   `auth.step_up_required` with no methods (they sign in again).
 *
 * Wrong proofs back off per user (`CREDENTIAL_LOCKOUT`), counted before the check:
 * second-factor codes under the shared {@link secondFactorLockKey}; a password and an emailed
 * code under one key of their own (`step_up:<environment>:<user>`), so the two cannot be
 * guessed in turn. An emailed code also has its token's own five guesses. A backup code is
 * spent.
 *
 * @param deps - Factor store, users, crypto, sessions, lockout, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param proof - The method and its proof.
 * @param origin - Where the request came from, for the audit log; and, for a passkey, the
 *   request's `Origin` header, which the assertion is verified against.
 * @returns The session id and a fresh access token. The refresh token is untouched.
 * @throws AuthError `auth.step_up_required` (a method this user may not use),
 *   `auth.invalid_credentials` (wrong password), `mfa.invalid_code`, `session.revoked`, for a
 *   passkey `auth.method_disabled` and `request.origin_not_allowed` (nothing counted), or for
 *   an emailed code `verification.invalid_code`, `verification.expired` and
 *   `verification.too_many_attempts`.
 * @throws RateLimitError while the user is locked out after repeated wrong proofs.
 */
export async function stepUp(
  deps: StepUpDeps,
  scope: Scope,
  self: { userId: string; sessionId: string },
  proof: StepUpRequest,
  origin: Partial<Origin> & { origin?: string | null } = {}
): Promise<SessionTokens> {
  const { userId } = self
  const actor: Actor = { type: 'user', id: userId, ...cleanOrigin(origin) }
  // The relying party before anything else, as the options route does: passkeys switched off,
  // or a missing or foreign origin, must not use up a guess of the budget this user's
  // authenticator codes share (nor the challenge).
  const rp =
    proof.method === 'passkey' ? await Passkeys.relyingParty(deps, scope, origin.origin) : null
  const allowed = await stepUpMethods(deps, scope, userId)
  if (!allowed.includes(proof.method)) {
    throw stepUpRequired(allowed)
  }
  if (proof.method === 'password' || proof.method === 'email_code') {
    const lockKey = stepUpLockKey(scope.environmentId, userId)
    const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
    if (!lock.allowed) {
      throw new RateLimitError(lock.retryAfterMs)
    }
    if (proof.method === 'email_code') {
      // A revoked or expired session must not spend the code: check it before the token.
      const session = await deps.sessions.findById(scope.environmentId, self.sessionId)
      if (!session || session.userId !== userId || !isActive(session, deps.clock.now())) {
        throw new AuthError('session.revoked')
      }
      const token = await Verification.verifyCode(deps, scope, {
        purpose: 'step_up',
        subject: { userId },
        code: proof.code,
        binding: self.sessionId,
      })
      const user = await deps.users.findById(scope.environmentId, userId)
      // The code proves the mailbox it went to: it must still be this account's address.
      if (!user?.emailVerifiedAt || user.emailNormalized !== token.destination) {
        throw new AuthError('verification.expired')
      }
      await deps.lockout.clear(lockKey)
      return Sessions.recordAuthentication(deps, scope, self, ['email'], actor)
    }
    const user = await deps.users.findById(scope.environmentId, userId)
    const found = user ? await Passwords.ofUser(deps, scope.environmentId, user) : null
    if (!(await Passwords.verify(found?.passwordHash ?? null, proof.password)) || !found) {
      throw new AuthError('auth.invalid_credentials')
    }
    await deps.lockout.clear(lockKey)
    return Sessions.recordAuthentication(deps, scope, self, ['pwd'], actor)
  }
  if (proof.method === 'sms_code') {
    // Still on, for this number, before anything is counted or spent.
    const user = await deps.users.findById(scope.environmentId, userId)
    if (!hasSmsFactor(user)) {
      throw stepUpRequired(allowed)
    }
    await requireSmsFactor(deps, scope, user.phoneNumber)
    const smsLockKey = await countGuess(deps, scope, userId)
    // A revoked or expired session must not spend the code.
    const session = await deps.sessions.findById(scope.environmentId, self.sessionId)
    if (!session || session.userId !== userId || !isActive(session, deps.clock.now())) {
      throw new AuthError('session.revoked')
    }
    const texted = await verifySmsCode(deps, scope, userId, {
      purpose: SMS_STEP_UP_PURPOSE,
      askedBy: { sessionId: self.sessionId },
      code: proof.code,
    })
    if (!texted) {
      throw new AuthError('mfa.invalid_code')
    }
    await deps.lockout.clear(smsLockKey)
    // `sms`, never `mfa`: see `isStrongSecondFactor`.
    return Sessions.recordAuthentication(deps, scope, self, ['sms'], actor)
  }
  const lockKey = await countGuess(deps, scope, userId)
  if (proof.method === 'passkey') {
    const challenge = await Passkeys.takeChallenge(deps, scope, self, 'step_up')
    const asserted =
      challenge && rp
        ? await Passkeys.assert(deps, scope, {
            credential: proof.credential,
            challenge,
            rp,
            userId,
            actor,
          })
        : null
    if (!asserted) {
      throw new AuthError('auth.invalid_credentials')
    }
    await deps.lockout.clear(lockKey)
    return Sessions.recordAuthentication(deps, scope, self, [...asserted.methods, 'mfa'], actor)
  }
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
