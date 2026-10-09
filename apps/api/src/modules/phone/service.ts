import {
  type CurrentUser,
  durationToMs,
  maskPhoneNumber,
  type PhoneCodeSent,
  parsePhoneNumber,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, RateLimitError } from '~/exceptions'
import { type Actor, cleanOrigin, type Origin } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as Settings from '~/modules/settings/service'
import * as Sms from '~/modules/sms/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import type { UserRecord } from '~/ports/user-repository'

// A phone number on an account (ADR 0037): a signed-in user asks for a code to be texted to
// a number, and proves the number with it. Until then the number is only "pending", and the
// pending number lives on the verification token (its `destination`), nowhere else.
//
// A number is not unique: two accounts may hold the same one. Where the environment has the
// SMS code on, a number that exactly one account has proven within the last year signs that
// account in (`signInHolder`, the one lookup by number; the flow service is its one caller).
// Nothing else finds an account from a number.

/** The purpose of a phone code's verification token. Honoured for nothing else. */
export const PHONE_PURPOSE = 'phone_verification'

/**
 * The purpose of the texted code that is a sign-in's first factor. Honoured for nothing else,
 * and a `phone_verification` code is never honoured for it.
 */
export const SMS_SIGN_IN_PURPOSE = 'sms_sign_in'

/**
 * How long ago, at most, a number may have been proven and still sign its account in.
 *
 * "Proven" is the later of the code that put the number on the account and the last sign-in
 * with a code texted to it; both move `phoneNumberVerifiedAt`. Carriers hand a number that
 * was given up to someone else, typically after some months: a number nobody has shown to be
 * theirs for a year is treated, for signing in, as nobody's. Its owner proves it again from
 * their account (the add and confirm routes), signed in another way.
 */
export const PHONE_SIGN_IN_PROOF_MAX_AGE = '365d'

/** Keyed-hash purpose of the lockout key of a sign-in by phone number. */
export const SIGN_IN_LOCK_HASH_PURPOSE = 'sms-sign-in-lockout'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/**
 * The lockout key for signing in to one phone number in one environment: what
 * `signInLockKey` is for an email address, for an identifier that is a number.
 *
 * A keyed hash that also covers the environment: a plain hash of a phone number is undone
 * by trying every number, and lockout keys may live in Redis. Every guess at such an
 * identifier counts under it, whatever is guessed at (a texted code, or a password typed
 * for a number, which never matches), so there is one budget per identifier.
 *
 * @param deps - The keyed hash.
 * @param environmentId - The environment.
 * @param phoneNumber - The number being signed in to, in E.164 form.
 * @returns The key for `deps.lockout`.
 */
export async function signInLockKey(
  deps: Pick<Deps, 'keyedHash'>,
  environmentId: string,
  phoneNumber: string
): Promise<string> {
  const hash = await deps.keyedHash.hmac(
    SIGN_IN_LOCK_HASH_PURPOSE,
    `${environmentId}:${phoneNumber}`
  )
  return `sign_in_phone:${environmentId}:${hash}`
}

/**
 * The account a phone number signs in to, if there is exactly one: **the only place an
 * account is found from a number** (ADR 0037), called by the flow service's `sms_code` steps
 * and by nothing else (`lookup.test.ts` walks the sources).
 *
 * `null`, with nothing to tell the cases apart, when:
 *
 * - nobody in the environment holds the number;
 * - **more than one account holds it.** A number is not unique, and none of the holders is
 *   preferred: not the first, whose claim may be the stale one of a number that has since
 *   been reassigned; not the latest, because then whoever can read one message to a number
 *   could put it on an account of their own and have its real owner signed in to that
 *   account instead of theirs. Until all but one of them remove it, it signs nobody in;
 * - the one holder last proved it more than {@link PHONE_SIGN_IN_PROOF_MAX_AGE} ago.
 *
 * A banned holder is returned like any other: a ban is told only to someone who has proven
 * the number, as for an email address.
 *
 * @param deps - Users and the clock.
 * @param scope - The environment.
 * @param phoneNumber - The number, in E.164 form.
 * @returns The one account, or `null`.
 */
export async function signInHolder(
  deps: Pick<Deps, 'users' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  phoneNumber: string
): Promise<UserRecord | null> {
  // Two are enough to know there is not exactly one.
  const [holder, another] = await deps.users.findByPhoneNumber(scope.environmentId, phoneNumber, 2)
  if (!holder || another || holder.phoneNumberVerifiedAt === null) {
    return null
  }
  const age = deps.clock.now().getTime() - holder.phoneNumberVerifiedAt.getTime()
  return age <= durationToMs(PHONE_SIGN_IN_PROOF_MAX_AGE) ? holder : null
}

/**
 * Note that a sign-in has just proven a user's number again, so that it does not lapse
 * ({@link PHONE_SIGN_IN_PROOF_MAX_AGE}). Bookkeeping: a failure is the caller's to log,
 * never a failed sign-in.
 *
 * @param deps - Users and the clock.
 * @param scope - The environment.
 * @param userId - The user who signed in.
 * @param phoneNumber - The number the code was texted to.
 */
export async function recordSignInProof(
  deps: Pick<Deps, 'users' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string,
  phoneNumber: string
): Promise<void> {
  await deps.users.recordPhoneNumberProof(
    scope.environmentId,
    userId,
    phoneNumber,
    deps.clock.now()
  )
}

/**
 * The lockout key of a signed-in user's guesses at a texted code.
 *
 * Per user, like the other budgets of someone who holds a session, and **its own**: it is
 * not `Mfa.stepUpLockKey`. A success clears the key it counted under, and whoever holds a
 * session can always succeed here with a phone of their own; sharing the step-up key would
 * let that reset the budget of guesses at the account's password.
 *
 * @param environmentId - The environment.
 * @param userId - The signed-in user.
 * @returns The key for `deps.lockout`. Ids only: lockout keys may live in Redis.
 */
export function codeLockKey(environmentId: string, userId: string): string {
  return `phone_code:${environmentId}:${userId}`
}

/**
 * What a phone code's keyed hash also covers: the user and the number. A code then proves
 * that number for that user and nothing else, even if a row were moved or rewritten.
 */
function binding(userId: string, phoneNumber: string): string {
  return `${userId}:${phoneNumber}`
}

type RequestDeps = Pick<
  Deps,
  | 'clock'
  | 'ids'
  | 'keyedHash'
  | 'verificationTokens'
  | 'mailer'
  | 'sms'
  | 'smsUsage'
  | 'rateLimiter'
  | 'environmentSettings'
  | 'config'
>

/** Where a request for a code came from, for the send limits. */
export interface RequestSource {
  /**
   * The request's address as the per-IP limits read it (`ipBucket(clientIp(c, …))`). Left
   * out for a call no request made: the per-address limit is then not applied, and every
   * other limit is.
   */
  address?: string | null
}

/**
 * Text the signed-in user a 6-digit code for a phone number they want on their account.
 *
 * The number becomes the user's **pending** number: it is kept on the code's verification
 * token and replaces a number that was pending before. The account's own number, if it has
 * one, is untouched until the code is confirmed ({@link verify}).
 *
 * The number must have the shape of one (`phone.invalid`). Everything else that decides
 * whether a message goes is `Sms.sendCode`, the one place a text message is sent from: the
 * environment's settings and country list, the deployment's sender, every send limit and the
 * daily limit, in that order, with nothing counted before the step that refuses. This
 * function tells it who asks (the user), from where, and whether the number is **new** to
 * them: not the one their last code was texted to. The token is stored only after the
 * message was sent, so a send that fails or is refused leaves an earlier code working.
 *
 * The code is a verification token of purpose `phone_verification`, stored as a keyed hash
 * that also covers the user's id and the number.
 *
 * @param deps - Settings, the SMS sender, the rate limiter, the token store, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param input - The number as the user typed it.
 * @param source - The request's address.
 * @returns The masked number and when the code expires. Never the code.
 * @throws AuthError `phone.invalid`, `sms.disabled`, `sms.country_not_allowed` or
 *   `sms.unavailable` (the message could not be sent).
 * @throws RateLimitError when a send limit, or the environment's daily limit, is spent.
 * @throws ServiceUnavailableError when the rate limiter cannot answer (nothing is sent).
 */
export async function request(
  deps: RequestDeps,
  scope: Scope,
  self: { userId: string },
  input: { phoneNumber: string },
  source: RequestSource = {}
): Promise<PhoneCodeSent> {
  const phoneNumber = parsePhoneNumber(input.phoneNumber)
  if (phoneNumber === null) {
    throw new AuthError('phone.invalid')
  }
  // The number the user's last code went to, whatever became of that code. A read: nothing
  // is counted by it, and a number the settings refuse is refused all the same.
  const last = await deps.verificationTokens.findLatest(scope.environmentId, PHONE_PURPOSE, {
    userId: self.userId,
  })
  const issued = await Verification.issue(deps, scope, {
    purpose: PHONE_PURPOSE,
    destination: phoneNumber,
    userId: self.userId,
    binding: binding(self.userId, phoneNumber),
    sendLimits: Verification.LIMITED_BY_DELIVERY,
    deliver: ({ code }) =>
      Sms.sendCode(deps, scope, {
        to: phoneNumber,
        code,
        asker: { type: 'user', id: self.userId },
        newNumber: last?.destination !== phoneNumber,
        address: source.address ?? null,
      }),
  })
  return {
    destination: maskPhoneNumber(phoneNumber),
    expiresAt: issued.expiresAt.toISOString(),
  }
}

type VerifyDeps = Pick<
  Deps,
  | 'clock'
  | 'ids'
  | 'keyedHash'
  | 'verificationTokens'
  | 'lockout'
  | 'users'
  | 'smsUsage'
  | 'environmentSettings'
  | 'config'
  | 'mailer'
  | 'rateLimiter'
>

/**
 * Confirm the pending number with the code texted to it, and make it the account's number.
 *
 * In order:
 * 1. SMS must still be on (`sms.disabled`), and the pending number's country still allowed
 *    (`sms.country_not_allowed`): a code asked for before either changed is not honoured
 *    after. Nothing is counted or spent by these;
 * 2. the guess is counted under the user's {@link codeLockKey} (`CREDENTIAL_LOCKOUT`),
 *    **before** the code is looked at;
 * 3. the code is checked against the newest `phone_verification` token of this user, with
 *    the binding of this user and that token's number. The token has five guesses of its
 *    own, and is spent by the right one;
 * 4. the number and the time are stored on the user, with `user.phone_number_added`, in one
 *    transaction. It replaces a number the account had. **A texted code that was the
 *    account's second factor goes with the number it was texted to** (ADR 0025), in that
 *    same transaction, recorded (`user.sms_factor_removed`, `phone_number_changed`) and
 *    announced to the owner; proving the same number again keeps it.
 *
 * @param deps - Settings, token store, lockout, users, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param input - The code.
 * @param origin - Where the request came from, for the audit log.
 * @returns The user as they now are.
 * @throws AuthError `sms.disabled`, `sms.country_not_allowed`, `verification.expired` (no
 *   pending number, or its code expired, was used or was replaced),
 *   `verification.invalid_code` or `verification.too_many_attempts`.
 * @throws RateLimitError while the user is locked out after repeated wrong codes.
 */
export async function verify(
  deps: VerifyDeps,
  scope: Scope,
  self: { userId: string },
  input: { code: string },
  origin: Partial<Origin> = {}
): Promise<CurrentUser> {
  const { userId } = self
  const actor: Actor = { type: 'user', id: userId, ...cleanOrigin(origin) }
  await Settings.requireSms(deps, scope)
  const now = deps.clock.now()
  const pending = await deps.verificationTokens.findLatest(scope.environmentId, PHONE_PURPOSE, {
    userId,
  })
  if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= now.getTime()) {
    // Nothing is pending: there is no code to guess at, so nothing is counted.
    throw new AuthError('verification.expired')
  }
  await Settings.requireSms(deps, scope, pending.destination)

  const lockKey = codeLockKey(scope.environmentId, userId)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, now)
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  const token = await Verification.verifyCode(deps, scope, {
    purpose: PHONE_PURPOSE,
    subject: { userId },
    code: input.code,
    // The number of the token read above. Should a newer token have replaced it meanwhile,
    // its number differs and the code does not check out: never the wrong number stored.
    binding: binding(userId, pending.destination),
  })
  // Read before the write, for the notice only: what the store does is decided under the
  // row's lock, whatever this says.
  const before = await deps.users.findById(scope.environmentId, userId)
  const stored = await deps.users.setPhoneNumber(
    scope.environmentId,
    userId,
    token.destination,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.phone_number_added',
      actor,
      target: { type: 'user', id: userId },
    }),
    Audit.entry(deps, scope, {
      type: 'user.sms_factor_removed',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'phone_number_changed' },
    })
  )
  if (!stored) {
    // The account was deleted while its access token was still valid.
    throw new AuthError('verification.expired')
  }
  if (before?.smsFactorEnabledAt && before.phoneNumber !== token.destination) {
    Notices.mfaChanged(deps, scope, before, { change: 'sms_removed', at: deps.clock.now() })
  }
  await deps.lockout.clear(lockKey)
  // The code was used: counted against the prefix and the day it was sent on (what an
  // operator reads to tell codes that are read from codes that are only paid for).
  await Sms.recordUsed(deps, scope, { to: token.destination, sentAt: token.createdAt })
  return Users.me(deps, scope, userId)
}

/**
 * Take the phone number off the signed-in user's account. Recorded
 * (`user.phone_number_removed`) in the same transaction, only when there was one.
 *
 * A number that is still pending is not touched: it is not the account's, and its code
 * expires by itself.
 *
 * **A texted code that was the account's second factor goes with the number** (ADR 0025), in
 * the same transaction, recorded (`user.sms_factor_removed`, `phone_number_removed`) and
 * announced to the owner. Where the environment requires a second factor the user's next
 * sign-in then stops at an enrolment.
 *
 * @param deps - Users, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param origin - Where the request came from, for the audit log.
 * @returns Whether a number was removed.
 */
export async function remove(
  deps: Pick<
    Deps,
    'users' | 'ids' | 'clock' | 'mailer' | 'rateLimiter' | 'environmentSettings' | 'config'
  >,
  scope: Scope,
  self: { userId: string },
  origin: Partial<Origin> = {}
): Promise<boolean> {
  const actor: Actor = { type: 'user', id: self.userId, ...cleanOrigin(origin) }
  // For the notice only (see `verify`).
  const before = await deps.users.findById(scope.environmentId, self.userId)
  const removed = await deps.users.removePhoneNumber(
    scope.environmentId,
    self.userId,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.phone_number_removed',
      actor,
      target: { type: 'user', id: self.userId },
    }),
    Audit.entry(deps, scope, {
      type: 'user.sms_factor_removed',
      actor,
      target: { type: 'user', id: self.userId },
      data: { method: 'phone_number_removed' },
    })
  )
  if (removed && before?.smsFactorEnabledAt) {
    Notices.mfaChanged(deps, scope, before, { change: 'sms_removed', at: deps.clock.now() })
  }
  return removed
}
