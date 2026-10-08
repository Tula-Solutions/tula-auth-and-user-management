import { sha256Hex } from '~/lib/crypto'

/** How failed attempts turn into waiting time. */
export interface LockoutPolicy {
  /** Failures allowed before any waiting is imposed. */
  freeAttempts: number
  /** Wait after the first failure beyond {@link LockoutPolicy.freeAttempts}; doubles each time. */
  baseDelayMs: number
  /** Longest wait a single failure can impose. */
  maxDelayMs: number
  /** Failures are forgotten after this long without a new one. */
  forgetAfterMs: number
}

/** Whether an attempt may proceed. */
export interface LockoutDecision {
  allowed: boolean
  /** Milliseconds until the next attempt is allowed (0 when `allowed`). */
  retryAfterMs: number
}

/**
 * Lockout for guessing secrets: 5 free tries, then 30s, 1m, 2m… up to 15 minutes per further
 * failure, forgotten after an hour of quiet.
 *
 * An attacker gets 5 guesses at once, 5 more within the first 15 minutes and 4 an hour after
 * that, instead of the unlimited stream a per-IP limit alone allows from many addresses.
 */
export const CREDENTIAL_LOCKOUT: LockoutPolicy = {
  freeAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  forgetAfterMs: 60 * 60_000,
}

/**
 * The wait a failure imposes under a policy.
 *
 * Shared by every adapter so they agree on the schedule.
 *
 * @param policy - The lockout policy.
 * @param failures - Failures counted so far, including this one.
 * @returns Milliseconds to wait before the next attempt (0 within the free attempts).
 */
export function lockoutDelayMs(policy: LockoutPolicy, failures: number): number {
  const over = failures - policy.freeAttempts
  if (over <= 0) {
    return 0
  }
  // Cap the exponent as well as the result: 2 ** 1024 is Infinity.
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(over - 1, 30))
}

/**
 * Exponential backoff for attempts at guessing a secret (a password), keyed by what is being
 * attacked (an identifier or a user), not by who is asking.
 *
 * In process memory for one instance, in Redis when several share the count (ADR 0016). An
 * adapter whose storage is unreachable throws `service.unavailable`: an attempt is never
 * allowed uncounted.
 */
export interface Lockout {
  /**
   * Register an attempt, counting it as a failure **up front** and atomically. Counting before
   * the secret is compared means concurrent guesses can't all slip through while unlocked; a
   * successful attempt then calls {@link Lockout.clear}.
   *
   * @param key - What is being guessed at, e.g. `sign_in:<environment>:<identifier hash>`.
   * @param policy - The backoff schedule.
   * @param now - Current time.
   * @returns Whether the attempt may proceed. A refused attempt is not counted.
   */
  attempt(key: string, policy: LockoutPolicy, now: Date): Promise<LockoutDecision>

  /**
   * Forget a key's failures after a successful attempt.
   *
   * @param key - The key passed to {@link Lockout.attempt}.
   */
  clear(key: string): Promise<void>
}

/**
 * The lockout key for password sign-in of one identifier in one environment.
 *
 * The identifier is hashed so that lockout storage (process memory or Redis) holds no email
 * address.
 *
 * @param environmentId - The environment.
 * @param identifier - The normalized identifier (email) being signed in to.
 * @returns The key to pass to {@link Lockout.attempt} and {@link Lockout.clear}.
 */
export function signInLockKey(environmentId: string, identifier: string): string {
  return `sign_in:${environmentId}:${sha256Hex(identifier)}`
}
