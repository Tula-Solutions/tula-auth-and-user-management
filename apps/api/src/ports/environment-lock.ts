/**
 * What an environment lock serialises. One name per invariant that spans more than one store:
 *
 * - `sign_in_methods`: "an environment always has at least one way to sign in" is decided from
 *   the settings document **and** the OAuth provider rows, which are written by different
 *   routes. Each write re-checks the rule while holding this lock (ADR 0026).
 * - `webhook_endpoints`: "an environment has at most `MAX_WEBHOOK_ENDPOINTS` endpoints" is a
 *   count and then an insert; a registration does both while holding this lock (ADR 0034).
 * - `sms_daily`: "an environment sends at most `sms.dailyMessageLimit` text messages a day" is
 *   a read of the day's count and then an addition to it; `Sms.sendCode` does both while
 *   holding this lock, before the message is sent and never while it is (ADR 0037).
 */
export type EnvironmentLockScope = 'sign_in_methods' | 'webhook_endpoints' | 'sms_daily'

/**
 * Makes writes that share an invariant take turns, per environment and across API instances.
 *
 * Unlike {@link import('./job-lock').JobLock}, a caller that finds the lock taken **waits** for
 * it: the second one must be decided against what the first one wrote, not refused because it
 * arrived at the same moment. The wait is bounded. Its callers are administrator requests and
 * one user request, the send of a text message, which reaches it only after every send limit
 * has let it through.
 *
 * It is not reentrant: `fn` must not ask for the same environment and scope again.
 */
export interface EnvironmentLock {
  /**
   * Run `fn` while no other caller runs one for the same environment and scope.
   *
   * @param environmentId - The environment whose writes take turns.
   * @param scope - Which invariant.
   * @param fn - The check and the write. The lock is released when it settles.
   * @returns `fn`'s result.
   * @throws Whatever `fn` throws; `ServiceUnavailableError` when the lock could not be had
   *   within the adapter's wait (nothing was run), or the lock's own failure.
   */
  runExclusive<T>(
    environmentId: string,
    scope: EnvironmentLockScope,
    fn: () => Promise<T>
  ): Promise<T>
}
