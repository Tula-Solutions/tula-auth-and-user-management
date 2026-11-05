import type { Env } from '~/env'

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/

/**
 * Whether the `local` outbound tier (loopback webhook and hook targets allowed) runs on a
 * deployment that is reachable from elsewhere: a `local` tier behind a public address is
 * almost certainly a misconfigured production, and the tier lets an operator aim a webhook
 * at the server's own loopback services.
 *
 * @param env - The parsed environment.
 * @returns True when the tier is `local` and `PUBLIC_URL` is not a loopback address.
 */
export function localTierIsExposed(env: Pick<Env, 'ENVIRONMENT' | 'PUBLIC_URL'>): boolean {
  if (env.ENVIRONMENT !== 'local') {
    return false
  }
  try {
    return !LOOPBACK.test(new URL(env.PUBLIC_URL).hostname)
  } catch {
    return true
  }
}
