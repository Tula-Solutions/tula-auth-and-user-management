/**
 * Short-lived denylist of revoked session ids.
 *
 * Access tokens are verified without a database hit, so a revoked session's token would stay
 * valid until it expires (about a minute). `sessionAuth` checks this list to close that gap.
 * Entries only need to live as long as the longest access token.
 *
 * In process memory for one instance, in Redis when several must agree (ADR 0016). An adapter
 * whose storage is unreachable throws `service.unavailable` from `has`: a token is not accepted
 * while nobody can say whether its session was revoked.
 */
export interface RevokedSessions {
  /**
   * @param sessionId - The revoked session.
   * @param until - When its last access token will have expired; the entry may be dropped then.
   */
  add(sessionId: string, until: Date): Promise<void>

  /**
   * @param sessionId - The `sid` of a verified access token.
   * @param now - Current time.
   * @returns Whether the session was revoked and may still have live access tokens.
   */
  has(sessionId: string, now: Date): Promise<boolean>
}
