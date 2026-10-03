/**
 * What a verification token proves: control of an address being verified, the right to reset
 * its account's password, or (`sign_in`) the email first factor of a sign-in. A token issued for
 * one purpose is never honoured for another.
 */
export type VerificationPurpose = 'email_verification' | 'password_reset' | 'sign_in'

/** What a token belongs to: an in-progress flow attempt, or an existing user. */
export type VerificationSubject = { flowAttemptId: string } | { userId: string }

/** A stored verification token. Only hashes of the code and link token are kept. */
export interface VerificationTokenRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string | null
  flowAttemptId: string | null
  purpose: VerificationPurpose
  /** Normalized email it was sent to. */
  destination: string
  /** `HMAC(verification key, "<id>:<code>")`, hex. */
  codeHash: string
  /** SHA-256 of the magic-link token, or `null` when no link was sent. */
  linkTokenHash: string | null
  /** Wrong-or-right guesses counted so far. */
  attempts: number
  maxAttempts: number
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

/** A token to store. */
export type NewVerificationToken = Omit<VerificationTokenRecord, 'attempts' | 'consumedAt'>

/**
 * The subject a token is looked up by: its flow attempt when it has one, otherwise its user.
 *
 * Shared by every adapter so they agree on which earlier tokens a new one replaces.
 *
 * @param token - A token's subject columns.
 * @returns The lookup subject.
 * @throws Error when the token has neither a flow attempt nor a user.
 */
export function subjectOf(
  token: Pick<VerificationTokenRecord, 'flowAttemptId' | 'userId'>
): VerificationSubject {
  if (token.flowAttemptId) {
    return { flowAttemptId: token.flowAttemptId }
  }
  if (token.userId) {
    return { userId: token.userId }
  }
  throw new Error('verification token needs a flow attempt or a user')
}

/** Verification tokens, always read and written inside one environment. */
export interface VerificationTokenStore {
  /**
   * Store a token and, in the same transaction, consume every earlier unconsumed token with the
   * same purpose and subject, so only the newest code or link works.
   *
   * @param token - The token to store.
   * @param at - Consumption time for the tokens it replaces.
   */
  replace(token: NewVerificationToken, at: Date): Promise<void>

  /**
   * @param environmentId - The environment to look in.
   * @param purpose - Token purpose.
   * @param subject - Flow attempt or user.
   * @returns The newest token for that subject (whatever its state), or `null`.
   */
  findLatest(
    environmentId: string,
    purpose: VerificationPurpose,
    subject: VerificationSubject
  ): Promise<VerificationTokenRecord | null>

  /**
   * @param environmentId - The environment to look in.
   * @param linkTokenHash - SHA-256 of the presented link token.
   * @returns The token, or `null`.
   */
  findByLinkHash(
    environmentId: string,
    linkTokenHash: string
  ): Promise<VerificationTokenRecord | null>

  /**
   * Count one guess, atomically, before the code is compared: concurrent guesses can then never
   * exceed `maxAttempts` between them.
   *
   * @param environmentId - The token's environment.
   * @param id - Token id.
   * @param now - Current time.
   * @returns The token with the incremented counter, or `null` when it is consumed, expired or
   *   already out of attempts (nothing is counted).
   */
  recordAttempt(
    environmentId: string,
    id: string,
    now: Date
  ): Promise<VerificationTokenRecord | null>

  /**
   * Mark a token used. Single-use: only the first caller wins.
   *
   * @param environmentId - The token's environment.
   * @param id - Token id.
   * @param now - Current time.
   * @returns `false` when it was already consumed or has expired.
   */
  consume(environmentId: string, id: string, now: Date): Promise<boolean>

  /**
   * Remove tokens in an environment that expired at or before `before`, consumed or not. Every
   * token expires, so this is also what removes consumed ones. At most `limit` go per call, so
   * no call holds locks for long; the caller repeats while a full batch comes back.
   *
   * @param environmentId - The environment to purge.
   * @param before - Tokens with `expiresAt <= before` go.
   * @param limit - The most tokens to remove in this call.
   * @returns How many tokens were removed.
   */
  deleteExpired(environmentId: string, before: Date, limit: number): Promise<number>
}
