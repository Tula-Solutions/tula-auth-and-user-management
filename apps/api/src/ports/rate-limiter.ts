/** The outcome of counting one request against a limit. */
export interface RateLimitDecision {
  /** Whether this request is within the limit. */
  allowed: boolean
  /** Requests left in the current window after this one (0 when blocked). */
  remaining: number
  /** Milliseconds until the window resets. */
  retryAfterMs: number
}

/**
 * Counts requests per key in fixed windows: in process memory for one instance, in Redis when
 * several share the count (ADR 0016).
 *
 * An adapter whose storage is unreachable throws `service.unavailable`; it never reports a
 * request as allowed without having counted it.
 */
export interface RateLimiter {
  /**
   * Count one request for `key` and decide whether it is allowed.
   *
   * @param key - Bucket name, e.g. `sign_in:ip:203.0.113.7`. May hold an IP address but never
   *   an email address: callers hash those first.
   * @param limit - Maximum requests per window.
   * @param windowMs - Window length in milliseconds.
   * @returns The decision.
   */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>
}
