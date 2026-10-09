/**
 * What an environment lock serialises. One name per invariant that spans more than one store:
 *
 * - `sign_in_methods`: "an environment always has at least one way to sign in" is decided from
 *   the settings document **and** the OAuth provider rows, which are written by different
 *   routes. Each write re-checks the rule while holding this lock (ADR 0026).
 * - `webhook_endpoints`: "an environment has at most `MAX_WEBHOOK_ENDPOINTS` endpoints" is a
 *   count and then an insert; a registration does both while holding this lock (ADR 0034).
 * - `native_apps`: "an environment has at most `MAX_NATIVE_APPS` native apps", a count and
 *   then an insert in the same way (ADR 0040).
 */
export type EnvironmentLockScope = 'sign_in_methods' | 'webhook_endpoints' | 'native_apps'

/**
 * Makes writes that share an invariant take turns, per environment and across API instances.
 *
 * Unlike {@link import('./job-lock').JobLock}, a caller that finds the lock taken **waits** for
 * it: these are administrator requests, and the second one must be decided against what the
 * first one wrote, not refused because it arrived at the same moment. The wait is bounded.
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
