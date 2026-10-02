import { durationToMs } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InternalError, RateLimitError } from '~/exceptions'
import { randomDigits, randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { maskEmail, normalizeEmail } from '~/lib/email'
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
  normalized: string
): Promise<void> {
  // Hash the address so limiter keys (which may live in Redis) hold no email.
  const key = `${scope.environmentId}:${sha256Hex(normalized)}`
  const limits = [
    ['verification_cooldown', 1, RESEND_COOLDOWN],
    ['verification_hourly', SENDS_PER_HOUR, '1h'],
  ] as const
  for (const [name, limit, window] of limits) {
    const decision = await deps.rateLimiter.hit(`${name}:${key}`, limit, durationToMs(window))
    if (!decision.allowed) {
      throw new RateLimitError(decision.retryAfterMs)
    }
  }
}

/**
 * Summarize a relay failure for logs without its message, which routinely quotes the recipient
 * (`550 <user@example.com>: rejected`). Error name, Node/nodemailer code and SMTP status are
 * enough to diagnose and contain no personal data.
 */
function describeMailFailure(error: unknown): string {
  const { name, code, responseCode } = (error ?? {}) as {
    name?: unknown
    code?: unknown
    responseCode?: unknown
  }
  return [name, code, responseCode]
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join(' ')
}

/**
 * Email a fresh 6-digit code (and optionally a magic link), replacing any earlier one.
 *
 * Only hashes are stored: the code as `HMAC(key, "<token id>:<code>")`, because a plain hash of
 * 10^6 values is reversible, and the link token as SHA-256. Sends are limited per destination so
 * the endpoint can't be used to flood an inbox or to farm fresh codes to guess. A failed send
 * still counts against those limits (the relay needs the breathing room) but leaves the
 * previous code valid.
 *
 * @param deps - Clock, ids, keyed hash, token store, mailer and rate limiter.
 * @param scope - The project and environment.
 * @param input - Purpose, destination, subject and optional link builder.
 * @returns The token id, masked destination and expiry.
 * @throws RateLimitError when the destination was emailed too recently or too often.
 * @throws InternalError when the email could not be sent, or no subject was given.
 */
export async function issue(
  deps: Pick<Deps, 'clock' | 'ids' | 'keyedHash' | 'verificationTokens' | 'mailer' | 'rateLimiter'>,
  scope: Scope,
  input: IssueInput
): Promise<IssuedVerification> {
  if (!input.flowAttemptId && !input.userId) {
    throw new InternalError({ internalMessage: 'verification needs a flow attempt or a user' })
  }
  const destination = normalizeEmail(input.destination)
  await enforceSendLimits(deps, scope, destination)

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
      : sendCode(deps, { purpose: input.purpose, ...delivery }))
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
      codeHash: await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, `${id}:${code}`),
      linkTokenHash: linkToken ? sha256Hex(linkToken) : null,
      maxAttempts: MAX_ATTEMPTS,
      expiresAt,
      createdAt: now,
    },
    now
  )
  return { id, destination: maskEmail(input.destination.trim()), expiresAt }
}

/** A code presented for a subject. */
export interface VerifyCodeInput {
  purpose: VerificationPurpose
  subject: VerificationSubject
  code: string
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
 * @returns The consumed token (its `userId`, `flowAttemptId` and `destination`).
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
  const presented = await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, `${token.id}:${input.code}`)
  if (!timingSafeEqual(presented, counted.codeHash)) {
    throw new AuthError('verification.invalid_code', {
      attemptsRemaining: counted.maxAttempts - counted.attempts,
    })
  }
  if (!(await deps.verificationTokens.consume(scope.environmentId, token.id, now))) {
    throw new AuthError('verification.expired')
  }
  return { ...counted, consumedAt: now }
}

/** A magic-link token presented for a purpose. */
export interface VerifyLinkInput {
  purpose: VerificationPurpose
  linkToken: string
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
 * @returns The consumed token.
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
  if (!token || token.purpose !== input.purpose) {
    throw new AuthError('verification.expired')
  }
  // Two concurrent issues can both commit before either consumes the other's token; only the
  // newest token for the subject is ever honoured, exactly as for codes.
  const latest = await deps.verificationTokens.findLatest(
    scope.environmentId,
    token.purpose,
    subjectOf(token)
  )
  if (
    latest?.id !== token.id ||
    !(await deps.verificationTokens.consume(scope.environmentId, token.id, now))
  ) {
    throw new AuthError('verification.expired')
  }
  return { ...token, consumedAt: now }
}
