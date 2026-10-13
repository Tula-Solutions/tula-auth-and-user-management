import type { CurrentUser, EmailCodeSent } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InvalidEmailError, NotFoundError, RateLimitError } from '~/exceptions'
import { type Actor, cleanOrigin, type Origin } from '~/lib/actor'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Email from '~/modules/email/service'
import * as Notices from '~/modules/notice/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import type { UserRecord } from '~/ports/user-repository'

// An email address for an account that has none (ADR 0059): one made by a first sign-in
// with a provider Tula takes no address from (X, Facebook; ADR 0026). The signed-in user
// asks for a code to be emailed to an address and proves the address with it. Until then
// the address is only "pending", and the pending address lives on the verification token
// (its `destination`), never on the user: there is no unverified address on an account by
// this path.
//
// Only for an account with NO address. Changing an address is another operation, with
// other risks (the old address is where notices and resets go), and does not exist.

/** The purpose of the code's verification token. Honoured for nothing else. */
export const EMAIL_ADDITION_PURPOSE = 'email_addition'

/** Codes one user may ask for in an hour, beside the one-a-minute cooldown. */
export const EMAIL_ADDITION_EMAILS_PER_HOUR = 5

/**
 * Emails of this kind one address is sent in an hour, whoever asks. A signed-in user chooses
 * the address, so without it a handful of accounts could fill a stranger's inbox.
 */
export const EMAIL_ADDITION_EMAILS_PER_ADDRESS_PER_HOUR = 5

/** Keyed-hash purpose of the per-address limiter key. */
export const ADDRESS_LIMIT_HASH_PURPOSE = 'email-addition-limits'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/**
 * The lockout key of a signed-in user's guesses at the emailed code.
 *
 * Per user and **its own**, as the phone number's is (`Phone.codeLockKey`): a success clears
 * the key it counted under, and whoever holds a session can always succeed here with an
 * inbox of their own, so sharing `Mfa.stepUpLockKey` would let that reset the budget of
 * guesses at something else.
 *
 * @param environmentId - The environment.
 * @param userId - The signed-in user.
 * @returns The key for `deps.lockout`. Ids only: lockout keys may live in Redis.
 */
export function codeLockKey(environmentId: string, userId: string): string {
  return `email_addition_code:${environmentId}:${userId}`
}

/**
 * What the code's keyed hash also covers: the user and the normalised address. A code then
 * proves that address for that user and nothing else, even if a row were moved or rewritten.
 */
function binding(userId: string, normalized: string): string {
  return `${userId}:${normalized}`
}

/**
 * The binding of a token whose code was never sent (the address is another account's). It
 * is not the binding a confirmation checks with, so no code matches such a token: not a
 * guess, and not the digits the server happened to draw.
 */
function decoyBinding(userId: string, normalized: string): string {
  return `decoy:${binding(userId, normalized)}`
}

/** The signed-in user, when they may add an address at all. */
async function requireAddressless(
  deps: Pick<Deps, 'users'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<UserRecord> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user) {
    // Deleted while its access token was still valid.
    throw new NotFoundError()
  }
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  if (user.email !== null) {
    throw new AuthError('email.already_set')
  }
  return user
}

type RequestDeps = Pick<
  Deps,
  | 'clock'
  | 'ids'
  | 'keyedHash'
  | 'verificationTokens'
  | 'mailer'
  | 'rateLimiter'
  | 'environmentSettings'
  | 'config'
  | 'users'
>

/**
 * Email the signed-in user a 6-digit code for an address they want on their account.
 *
 * The address becomes the user's **pending** address: it is kept on the code's verification
 * token and replaces an address that was pending before. Nothing is written to the user
 * until the code is confirmed ({@link verify}).
 *
 * **An address another account has is answered, limited and stored the same** as one that
 * is free: the same response, the same limiter rows, one email, one token. What is emailed
 * differs: that account's owner gets a notice with no code and no link (`email_in_use`), as
 * a sign-up with an existing address does, and the token stored is one no code matches. So
 * the asker cannot tell from this call whether the address has an account, and a
 * confirmation of such an address can never succeed.
 *
 * Sends are limited per user under keys of their own (one a minute, and
 * {@link EMAIL_ADDITION_EMAILS_PER_HOUR} an hour) and, counted after those, per address
 * ({@link EMAIL_ADDITION_EMAILS_PER_ADDRESS_PER_HOUR} an hour, under a keyed hash). Neither
 * is the per-address budget of the codes a stranger can ask for (a sign-in's, a reset's):
 * nobody who knows an address can use these sends to keep its owner from signing in.
 *
 * The code is a verification token of purpose `email_addition`, stored as a keyed hash that
 * also covers the user's id and the normalised address.
 *
 * @param deps - Users, token store, mailer, rate limiter, keyed hash, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param input - The address as the user typed it.
 * @returns The masked address and when the code expires. Never the code.
 * @throws InvalidEmailError for what is not an address.
 * @throws AuthError `email.already_set` for an account that has an address, or
 *   `auth.user_banned`.
 * @throws RateLimitError when a send limit is spent.
 * @throws ServiceUnavailableError when the rate limiter cannot answer (nothing is sent).
 */
export async function request(
  deps: RequestDeps,
  scope: Scope,
  self: { userId: string },
  input: { email: string }
): Promise<EmailCodeSent> {
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  await requireAddressless(deps, scope, self.userId)
  // Looked up for every address, so that a free one and a taken one cost the same read.
  const taken = (await deps.users.findByEmail(scope.environmentId, parsed.normalized)) !== null
  const issued = await Verification.issue(deps, scope, {
    purpose: EMAIL_ADDITION_PURPOSE,
    destination: parsed.email,
    userId: self.userId,
    binding: taken
      ? decoyBinding(self.userId, parsed.normalized)
      : binding(self.userId, parsed.normalized),
    sendLimits: {
      name: 'email_addition',
      subject: `${scope.environmentId}:${self.userId}`,
      perHour: EMAIL_ADDITION_EMAILS_PER_HOUR,
    },
    onAllowed: async () => {
      // A keyed hash that covers the environment: limiter keys may live in Redis.
      const address = await deps.keyedHash.hmac(
        ADDRESS_LIMIT_HASH_PURPOSE,
        `${scope.environmentId}:${parsed.normalized}`
      )
      const decision = await deps.rateLimiter.hit(
        `email_addition_address:${scope.environmentId}:${address}`,
        EMAIL_ADDITION_EMAILS_PER_ADDRESS_PER_HOUR,
        3_600_000
      )
      if (!decision.allowed) {
        throw new RateLimitError(decision.retryAfterMs)
      }
    },
    deliver: ({ to, code, ttlMinutes }) =>
      taken
        ? Email.send(deps, scope, to, { type: 'email_in_use' })
        : // The message that verifies an address at a sign-up: it says the same thing.
          Email.send(deps, scope, to, { type: 'email_verification', code, ttlMinutes }),
  })
  return { destination: issued.destination, expiresAt: issued.expiresAt.toISOString() }
}

type VerifyDeps = Pick<
  Deps,
  | 'clock'
  | 'ids'
  | 'keyedHash'
  | 'verificationTokens'
  | 'lockout'
  | 'users'
  | 'mailer'
  | 'rateLimiter'
  | 'environmentSettings'
  | 'config'
>

/**
 * Confirm the pending address with the code emailed to it, and make it the account's.
 *
 * In order:
 * 1. the user must still exist, not be banned and have no address (`email.already_set`).
 *    Nothing is counted or spent by these;
 * 2. with nothing pending (no code asked for, or it expired, was used or was replaced)
 *    there is no code to guess at: `verification.expired`, nothing counted;
 * 3. the guess is counted under the user's {@link codeLockKey} (`CREDENTIAL_LOCKOUT`),
 *    **before** the code is looked at;
 * 4. the code is checked against the newest `email_addition` token of this user, with the
 *    binding of this user and that token's address. The token has five guesses of its own,
 *    and is spent by the right one;
 * 5. the address, its verification time and its `email` identity are stored on the user,
 *    with `user.email_added`, in one transaction, **in which the unique key decides**: an
 *    address another account took since the code was sent stores nothing, and the answer is
 *    `verification.expired` with the code spent. Asking again then sends that account's
 *    owner the notice, which is where whoever holds the inbox learns why.
 *
 * The address is stored in its normalised form (ASCII letters in lower case): the token
 * keeps that and nothing else of what was typed.
 *
 * The account's owner is told at the new address (`Notices.emailAdded`), after the store.
 *
 * @param deps - Token store, lockout, users, ids, clock and what a notice needs.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param input - The code.
 * @param origin - Where the request came from, for the audit log.
 * @returns The user as they now are.
 * @throws AuthError `email.already_set`, `auth.user_banned`, `verification.expired`,
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
  await requireAddressless(deps, scope, userId)
  const now = deps.clock.now()
  const pending = await deps.verificationTokens.findLatest(
    scope.environmentId,
    EMAIL_ADDITION_PURPOSE,
    { userId }
  )
  if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= now.getTime()) {
    throw new AuthError('verification.expired')
  }
  const lockKey = codeLockKey(scope.environmentId, userId)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, now)
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  const token = await Verification.verifyCode(deps, scope, {
    purpose: EMAIL_ADDITION_PURPOSE,
    subject: { userId },
    code: input.code,
    // The address of the token read above. Should a newer token have replaced it meanwhile,
    // its address differs and the code does not check out: never the wrong address stored.
    binding: binding(userId, pending.destination),
  })
  const at = deps.clock.now()
  const stored = await deps.users.addEmail(
    scope.environmentId,
    userId,
    {
      email: token.destination,
      normalized: token.destination,
      verifiedAt: at,
      identityId: deps.ids.next(),
    },
    at,
    Audit.entry(deps, scope, {
      type: 'user.email_added',
      actor,
      target: { type: 'user', id: userId },
      data: { method: 'self', verified: true },
    })
  )
  if (stored === 'not_found') {
    throw new NotFoundError()
  }
  if (stored === 'has_email') {
    throw new AuthError('email.already_set')
  }
  if (stored === 'taken') {
    // Another account took the address between the send and now. The code is spent; ids only.
    logger.info('email address not added: another account has it', {
      environmentId: scope.environmentId,
      userId,
    })
    throw new AuthError('verification.expired')
  }
  await deps.lockout.clear(lockKey)
  Notices.emailAdded(deps, scope, stored, { at })
  return Users.me(deps, scope, userId)
}
