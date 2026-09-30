/** The outcome of counting one request against a limit. */
export interface RateLimitDecision {
  /** Whether this request is within the limit. */
  allowed: boolean
  /** Requests left in the current window after this one (0 when blocked). */
  remaining: number
  /** Milliseconds until the window resets. */
  retryAfterMs: number
}

/** Counts requests per key in fixed windows (memory now; Redis in Phase 1 for multi-instance). */
export interface RateLimiter {
  /**
   * Count one request for `key` and decide whether it is allowed.
   *
   * @param key - Bucket name, e.g. `sign_in:ip:203.0.113.7`.
   * @param limit - Maximum requests per window.
   * @param windowMs - Window length in milliseconds.
   * @returns The decision.
   */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>
}
