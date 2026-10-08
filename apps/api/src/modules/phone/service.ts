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
import * as Settings from '~/modules/settings/service'
import * as Sms from '~/modules/sms/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'

// A phone number on an account (ADR 0037): a signed-in user asks for a code to be texted to
// a number, and proves the number with it. Until then the number is only "pending", and the
// pending number lives on the verification token (its `destination`), nowhere else.
//
// A number is contact data in this version. Nobody signs in with one, nothing is looked up
// by one, and two accounts may hold the same one.

/** The purpose of a phone code's verification token. Honoured for nothing else. */
export const PHONE_PURPOSE = 'phone_verification'

/**
 * Phone codes one user may be texted in an hour, in one environment. A simple ceiling for
 * the signed-in case; the limits that bound what SMS can cost (per destination prefix, per
 * environment, the spend ceiling) are their own piece of work.
 */
export const PHONE_CODES_PER_HOUR = 5

/** Phone codes one number may be texted in an hour, in one environment, whoever asks. */
export const PHONE_CODES_PER_NUMBER_PER_HOUR = 5

/** Keyed-hash purpose of the per-number send-limit keys. */
export const PHONE_LIMIT_HASH_PURPOSE = 'phone-send-limits'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

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
  | 'rateLimiter'
  | 'environmentSettings'
  | 'config'
>

/**
 * Text the signed-in user a 6-digit code for a phone number they want on their account.
 *
 * The number becomes the user's **pending** number: it is kept on the code's verification
 * token and replaces a number that was pending before. The account's own number, if it has
 * one, is untouched until the code is confirmed ({@link verify}).
 *
 * In order, and nothing is counted or sent before the step that refuses:
 * 1. the number must have the shape of one (`phone.invalid`);
 * 2. the environment must allow a message to it (`Settings.requireSms`);
 * 3. the send limits: one a minute and {@link PHONE_CODES_PER_HOUR} an hour per user, then
 *    one a minute and {@link PHONE_CODES_PER_NUMBER_PER_HOUR} an hour per number. The
 *    number's keys hold a keyed hash of it, never the number;
 * 4. the message is sent, and only then is the token stored: a send that fails leaves an
 *    earlier code working.
 *
 * The code is a verification token of purpose `phone_verification`, stored as a keyed hash
 * that also covers the user's id and the number.
 *
 * @param deps - Settings, the SMS sender, the rate limiter, the token store, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param input - The number as the user typed it.
 * @returns The masked number and when the code expires. Never the code.
 * @throws AuthError `phone.invalid`, `sms.disabled`, `sms.country_not_allowed` or
 *   `sms.unavailable` (the message could not be sent).
 * @throws RateLimitError when a code was sent too recently or too often.
 * @throws ServiceUnavailableError when the rate limiter cannot answer (nothing is sent).
 */
export async function request(
  deps: RequestDeps,
  scope: Scope,
  self: { userId: string },
  input: { phoneNumber: string }
): Promise<PhoneCodeSent> {
  const phoneNumber = parsePhoneNumber(input.phoneNumber)
  if (phoneNumber === null) {
    throw new AuthError('phone.invalid')
  }
  await Settings.requireSms(deps, scope, phoneNumber)
  const issued = await Verification.issue(deps, scope, {
    purpose: PHONE_PURPOSE,
    destination: phoneNumber,
    userId: self.userId,
    binding: binding(self.userId, phoneNumber),
    sendLimits: {
      name: 'phone_code',
      subject: `${scope.environmentId}:${self.userId}`,
      perHour: PHONE_CODES_PER_HOUR,
    },
    onAllowed: () => limitNumber(deps, scope, phoneNumber),
    deliver: ({ code }) => Sms.sendCode(deps, scope, { to: phoneNumber, code }),
  })
  return {
    destination: maskPhoneNumber(phoneNumber),
    expiresAt: issued.expiresAt.toISOString(),
  }
}

/** Count a send against the number's own limits, whoever asked for it. */
async function limitNumber(
  deps: Pick<Deps, 'rateLimiter' | 'keyedHash'>,
  scope: Pick<Scope, 'environmentId'>,
  phoneNumber: string
): Promise<void> {
  // A keyed hash: limiter keys may live in Redis, and a number is personal data.
  const subject = `${scope.environmentId}:${await deps.keyedHash.hmac(
    PHONE_LIMIT_HASH_PURPOSE,
    `${scope.environmentId}:${phoneNumber}`
  )}`
  const limits = [
    [`phone_code_number_cooldown:${subject}`, 1, Verification.RESEND_COOLDOWN],
    [`phone_code_number:${subject}`, PHONE_CODES_PER_NUMBER_PER_HOUR, '1h'],
  ] as const
  // A limiter that cannot answer throws (ServiceUnavailableError): nothing is sent.
  for (const [key, limit, window] of limits) {
    const decision = await deps.rateLimiter.hit(key, limit, durationToMs(window))
    if (!decision.allowed) {
      throw new RateLimitError(decision.retryAfterMs)
    }
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
  | 'environmentSettings'
  | 'config'
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
 *    transaction. It replaces a number the account had.
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
  const stored = await deps.users.setPhoneNumber(
    scope.environmentId,
    userId,
    token.destination,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.phone_number_added',
      actor,
      target: { type: 'user', id: userId },
    })
  )
  if (!stored) {
    // The account was deleted while its access token was still valid.
    throw new AuthError('verification.expired')
  }
  await deps.lockout.clear(lockKey)
  return Users.me(deps, scope, userId)
}

/**
 * Take the phone number off the signed-in user's account. Recorded
 * (`user.phone_number_removed`) in the same transaction, only when there was one.
 *
 * A number that is still pending is not touched: it is not the account's, and its code
 * expires by itself.
 *
 * @param deps - Users, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param origin - Where the request came from, for the audit log.
 * @returns Whether a number was removed.
 */
export async function remove(
  deps: Pick<Deps, 'users' | 'ids' | 'clock'>,
  scope: Scope,
  self: { userId: string },
  origin: Partial<Origin> = {}
): Promise<boolean> {
  const actor: Actor = { type: 'user', id: self.userId, ...cleanOrigin(origin) }
  return deps.users.removePhoneNumber(
    scope.environmentId,
    self.userId,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.phone_number_removed',
      actor,
      target: { type: 'user', id: self.userId },
    })
  )
}
