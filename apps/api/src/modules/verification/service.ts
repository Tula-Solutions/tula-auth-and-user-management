import { durationToMs } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InternalError, RateLimitError } from '~/exceptions'
import { randomDigits, randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { maskEmail, normalizeEmail } from '~/lib/email'
import { describeMailFailure } from '~/lib/safe-error'
import {
  subjectOf,
  type VerificationPurpose,
  type VerificationSubject,
  type VerificationTokenRecord,
} from '~/ports/verification-token-store'
import { sendCode } from './mailer'

/** Digits in an emailed code. */
export const CODE_LENGTH = 6
/** How long a code or link stays valid. */
export const TOKEN_TTL = '10m'
/**
 * Guesses allowed per code. With 10^6 codes that is a 1-in-200,000 chance per issued code, and
 * the send limits below cap how many codes an attacker can request.
 */
export const MAX_ATTEMPTS = 5
/** Minimum gap between two emails to the same address in one environment. */
export const RESEND_COOLDOWN = '1m'
/** Emails per hour to the same address in one environment (also limits inbox flooding). */
export const SENDS_PER_HOUR = 5
/** Keyed-hash purpose for code hashes. */
export const KEYED_HASH_PURPOSE = 'verification-codes'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/** What to issue a code for. Give a flow attempt, a user, or both. */
export interface IssueInput {
  purpose: VerificationPurpose
  /** Email as the user entered it. */
  destination: string
  flowAttemptId?: string
  userId?: string
  /**
   * Something only the asker has (a session id), mixed into the stored code hash: the code then
   * checks out only when {@link VerifyCodeInput.binding} is the same. A value from the server's
   * own records, never client input and never a secret that must not reach the keyed hash.
   */
  binding?: string
  /**
   * Builds the magic-link URL from the link token. Omit to send a code only: the route that
   * accepts links belongs to the calling flow, so the flow decides the URL.
   */
  linkUrl?: (linkToken: string) => string
  /**
   * Replaces the standard code email. A flow uses it to send something else to the same
   * address (e.g. an "account already exists" notice) while everything a caller can observe,
   * the stored token, the send limits and the timing of one email, stays the same.
   */
  deliver?: (delivery: Delivery) => Promise<void>
  /**
   * Count this send under limits of the caller's own instead of the per-address ones.
   *
   * The per-address cooldown and hourly cap are shared by every code a stranger can ask for
   * (sign-in, password reset, email verification). A code only a signed-in user can ask for
   * must not share them: anyone who knows the address could keep it refused, and its sends
   * would use up the sign-in codes'. With this set, the address's limits are neither checked
   * nor counted.
   */
  sendLimits?: SendLimits
  /**
   * Runs once the per-address send limits have allowed the email, and before anything is sent.
   * Throw to refuse. Lets a caller apply a wider limit (e.g. per environment) that a send
   * already refused by the address cooldown should not count against.
   */
  onAllowed?: () => Promise<void>
}

/**
 * Send limits a caller brings in place of the per-address ones ({@link IssueInput.sendLimits}).
 * The same cooldown ({@link RESEND_COOLDOWN}) applies, counted under the caller's key.
 */
export interface SendLimits {
  /**
   * Names the limiter keys, which no other purpose may use: `<name>_cooldown:<subject>` and
   * `<name>:<subject>`.
   */
  name: string
  /**
   * What the sends are counted per, e.g. `<environment id>:<user id>`. It must name the
   * environment and hold ids or keyed hashes only, never an address: limiter keys may live
   * in Redis.
   */
  subject: string
  /** Emails per hour for that subject. */
  perHour: number
}

/** What a custom {@link IssueInput.deliver} receives. */
export interface Delivery {
  /** Recipient, as the user entered it (trimmed). */
  to: string
  code: string
  linkUrl: string | undefined
  ttlMinutes: number
}

/** What `issue` reports back. Never the code or link token. */
export interface IssuedVerification {
  id: string
  /** Masked destination for the `needs_email_verification` step, e.g. `m***@northline.app`. */
  destination: string
  expiresAt: Date
}

async function enforceSendLimits(
  deps: Pick<Deps, 'rateLimiter'>,
  scope: Scope,
  normalized: string,
  own: SendLimits | undefined
): Promise<void> {
  // Hash the address so limiter keys (which may live in Redis) hold no email.
  const address = `${scope.environmentId}:${sha256Hex(normalized)}`
  const limits = own
    ? ([
        [`${own.name}_cooldown:${own.subject}`, 1, RESEND_COOLDOWN],
        [`${own.name}:${own.subject}`, own.perHour, '1h'],
      ] as const)
    : ([
        [`verification_cooldown:${address}`, 1, RESEND_COOLDOWN],
        [`verification_hourly:${address}`, SENDS_PER_HOUR, '1h'],
      ] as const)
  // A limiter that cannot answer throws (ServiceUnavailableError): nothing is sent.
  for (const [key, limit, window] of limits) {
    const decision = await deps.rateLimiter.hit(key, limit, durationToMs(window))
    if (!decision.allowed) {
      throw new RateLimitError(decision.retryAfterMs)
    }
  }
}

/**
 * Email a fresh 6-digit code (and optionally a magic link), replacing any earlier one.
 *
 * Only hashes are stored: the code as `HMAC(key, "<token id>:<code>")`, because a plain hash of
 * 10^6 values is reversible, and the link token as SHA-256. Sends are limited per destination
 * (or under the caller's own {@link IssueInput.sendLimits}) so
 * the endpoint can't be used to flood an inbox or to farm fresh codes to guess. A failed send
 * still counts against those limits (the relay needs the breathing room) but leaves the
 * previous code valid.
 *
 * @param deps - Clock, ids, keyed hash, token store, mailer, rate limiter and settings.
 * @param scope - The project and environment.
 * @param input - Purpose, destination, subject and optional link builder.
 * @returns The token id, masked destination and expiry.
 * @throws RateLimitError when the destination was emailed too recently or too often.
 * @throws ServiceUnavailableError when the rate limiter cannot answer (nothing is sent).
 * @throws InternalError when the email could not be sent, or no subject was given.
 */
export async function issue(
  deps: Pick<
    Deps,
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
  input: IssueInput
): Promise<IssuedVerification> {
  if (!input.flowAttemptId && !input.userId) {
    throw new InternalError({ internalMessage: 'verification needs a flow attempt or a user' })
  }
  const destination = normalizeEmail(input.destination)
  await enforceSendLimits(deps, scope, destination, input.sendLimits)
  await input.onAllowed?.()

  const code = randomDigits(CODE_LENGTH)
  const linkToken = input.linkUrl ? randomToken() : null

  // Send first: if the relay fails, nothing is stored and the previous code keeps working.
  const delivery: Delivery = {
    to: input.destination.trim(),
    code,
    linkUrl: linkToken && input.linkUrl ? input.linkUrl(linkToken) : undefined,
    ttlMinutes: durationToMs(TOKEN_TTL) / 60_000,
  }
  try {
    await (input.deliver
      ? input.deliver(delivery)
      : sendCode(deps, scope, { purpose: input.purpose, ...delivery }))
  } catch (error) {
    throw new InternalError({
      internalMessage: `verification email could not be sent (${describeMailFailure(error)})`,
    })
  }

  // Stamp the token only now. "Newest" is decided by createdAt, so a send that hung in the
  // relay must not store a token that looks older than one issued while it was waiting.
  const now = deps.clock.now()
  const id = deps.ids.next()
  const expiresAt = new Date(now.getTime() + durationToMs(TOKEN_TTL))
  await deps.verificationTokens.replace(
    {
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: input.userId ?? null,
      flowAttemptId: input.flowAttemptId ?? null,
      purpose: input.purpose,
      destination,
      codeHash: await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, hashInput(id, code, input.binding)),
      linkTokenHash: linkToken ? sha256Hex(linkToken) : null,
      maxAttempts: MAX_ATTEMPTS,
      expiresAt,
      createdAt: now,
    },
    now
  )
  return { id, destination: maskEmail(input.destination.trim()), expiresAt }
}

/**
 * What a code's keyed hash is taken over: the token id, so equal codes hash differently, and
 * the binding when the token was issued with one. A token with a binding never matches a
 * check without it, or with another.
 */
function hashInput(tokenId: string, code: string, binding: string | undefined): string {
  return binding === undefined ? `${tokenId}:${code}` : `${tokenId}:${binding}:${code}`
}

/** A code presented for a subject. */
export interface VerifyCodeInput {
  purpose: VerificationPurpose
  subject: VerificationSubject
  code: string
  /** The {@link IssueInput.binding} the code was issued with, when it had one. */
  binding?: string
  /**
   * Pass `false` to leave a correct code unconsumed, when more must be checked before the code
   * is spent (a password reset checks the new password first). The caller then spends it with
   * {@link consume}; the guess is still counted, so the code allows no extra tries.
   */
  consume?: boolean
}

/**
 * Check an emailed code and consume its token.
 *
 * The guess is counted atomically **before** the comparison, so concurrent guesses can't exceed
 * {@link MAX_ATTEMPTS} between them. A missing, consumed, replaced or foreign token all report
 * `verification.expired`, which tells a caller nothing about which tokens exist.
 *
 * @param deps - Clock, keyed hash and token store.
 * @param scope - The environment the request resolved to.
 * @param input - Purpose, subject and the presented code.
 * @returns The token (its `userId`, `flowAttemptId` and `destination`), consumed unless
 *   `input.consume` is `false`.
 * @throws AuthError `verification.expired` (410), `verification.too_many_attempts` (429) or
 *   `verification.invalid_code` (422, with `attemptsRemaining`).
 */
export async function verifyCode(
  deps: Pick<Deps, 'clock' | 'keyedHash' | 'verificationTokens'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: VerifyCodeInput
): Promise<VerificationTokenRecord> {
  const now = deps.clock.now()
  const token = await deps.verificationTokens.findLatest(
    scope.environmentId,
    input.purpose,
    input.subject
  )
  if (!token || token.consumedAt || token.expiresAt.getTime() <= now.getTime()) {
    throw new AuthError('verification.expired')
  }
  const counted = await deps.verificationTokens.recordAttempt(scope.environmentId, token.id, now)
  if (!counted) {
    // Out of attempts, or a concurrent request consumed it. Either way: request a new code.
    throw new AuthError('verification.too_many_attempts')
  }
  const presented = await deps.keyedHash.hmac(
    KEYED_HASH_PURPOSE,
    hashInput(token.id, input.code, input.binding)
  )
  if (!timingSafeEqual(presented, counted.codeHash)) {
    throw new AuthError('verification.invalid_code', {
      attemptsRemaining: counted.maxAttempts - counted.attempts,
    })
  }
  if (input.consume === false) {
    return counted
  }
  await consume(deps, scope, token.id)
  return { ...counted, consumedAt: now }
}

/**
 * Spend a token whose code {@link verifyCode} accepted with `consume: false`.
 *
 * Single-use: of two requests holding the same correct code, only the first gets past this.
 *
 * @param deps - Clock and token store.
 * @param scope - The environment the request resolved to.
 * @param tokenId - The token.
 * @throws AuthError `verification.expired` when it was already used or has expired.
 */
export async function consume(
  deps: Pick<Deps, 'clock' | 'verificationTokens'>,
  scope: Pick<Tenant, 'environmentId'>,
  tokenId: string
): Promise<void> {
  if (!(await deps.verificationTokens.consume(scope.environmentId, tokenId, deps.clock.now()))) {
    throw new AuthError('verification.expired')
  }
}

/** A magic-link token presented for a purpose. */
export interface VerifyLinkInput {
  purpose: VerificationPurpose
  linkToken: string
  /**
   * Pass `false` to leave a good link unconsumed, when more must be checked before it is spent
   * (a sign-in link is only spent in the browser that asked for it). The caller then spends it
   * with {@link consume}.
   */
  consume?: boolean
}

/**
 * Check a magic-link token and consume its token (which also invalidates the code).
 *
 * Link tokens are 256-bit, so there is no attempt counter; every failure reports
 * `verification.expired`.
 *
 * @param deps - Clock and token store.
 * @param scope - The environment the request resolved to.
 * @param input - Purpose and the presented link token.
 * @returns The token, consumed unless `input.consume` is `false`.
 * @throws AuthError `verification.expired` when the link is unknown, used, expired, from another
 *   environment or for another purpose.
 */
export async function verifyLink(
  deps: Pick<Deps, 'clock' | 'verificationTokens'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: VerifyLinkInput
): Promise<VerificationTokenRecord> {
  const now = deps.clock.now()
  const token = await deps.verificationTokens.findByLinkHash(
    scope.environmentId,
    sha256Hex(input.linkToken)
  )
  if (
    !token ||
    token.purpose !== input.purpose ||
    token.consumedAt ||
    token.expiresAt.getTime() <= now.getTime()
  ) {
    throw new AuthError('verification.expired')
  }
  // Two concurrent issues can both commit before either consumes the other's token; only the
  // newest token for the subject is ever honoured, exactly as for codes.
  const latest = await deps.verificationTokens.findLatest(
    scope.environmentId,
    token.purpose,
    subjectOf(token)
  )
  if (latest?.id !== token.id) {
    throw new AuthError('verification.expired')
  }
  if (input.consume === false) {
    return token
  }
  await consume(deps, scope, token.id)
  return { ...token, consumedAt: now }
}
