import type { AuthState } from '@tula/core'
import { useCallback } from 'react'
import { useTulaContext } from '../context'
import { go } from '../navigation'
import { useAuthState } from './use-auth-state'

/**
 * What {@link useAuth} returns.
 *
 * @example
 * ```ts
 * const { isLoaded, isSignedIn }: UseAuthResult = useAuth()
 * ```
 */
export interface UseAuthResult {
  /** `loading` until the provider has found out who is signed in. */
  status: AuthState['status']
  /** Whether the answer is known: `status` is no longer `loading`. */
  isLoaded: boolean
  /** Whether someone is signed in. `false` while loading. */
  isSignedIn: boolean
  /** The current session's id, or `null`. */
  sessionId: string | null
  /**
   * An access token for your own backend, refreshed first when needed. Call it each time you
   * need one instead of keeping the result: tokens last about a minute.
   *
   * @returns The token, or `null` when nobody is signed in.
   * @throws TulaError when a needed refresh could not be made (offline, rate limited).
   */
  getToken(): Promise<string | null>
  /**
   * Sign out here and in the app's other tabs, then go to `redirectUrl` or the provider's
   * `afterSignOutUrl` if there is one.
   *
   * @param options - `redirectUrl`: where to go instead of `afterSignOutUrl`.
   * @throws TulaError when the server could not be told. The client is signed out all the
   *   same; no navigation happens.
   */
  signOut(options?: { redirectUrl?: string }): Promise<void>
}

/**
 * Who is signed in, and the two things an app does about it: get a token, sign out.
 *
 * @returns The authentication state and its actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function Orders() {
 *   const { isLoaded, isSignedIn, getToken } = useAuth()
 *   if (!isLoaded || !isSignedIn) {
 *     return null
 *   }
 *   const load = async () =>
 *     fetch('/api/orders', { headers: { authorization: `Bearer ${await getToken()}` } })
 *   return <button onClick={load}>Load orders</button>
 * }
 * ```
 */
export function useAuth(): UseAuthResult {
  const { client, navigation } = useTulaContext()
  const state = useAuthState(client)
  const { navigate, afterSignOutUrl } = navigation
  const getToken = useCallback(() => client.session.getToken(), [client])
  const signOut = useCallback(
    async (options: { redirectUrl?: string } = {}) => {
      await client.session.signOut()
      go(options.redirectUrl ?? afterSignOutUrl, navigate)
    },
    [client, navigate, afterSignOutUrl]
  )
  return {
    status: state.status,
    isLoaded: state.status !== 'loading',
    isSignedIn: state.status === 'signed-in',
    sessionId: state.status === 'signed-in' ? state.sessionId : null,
    getToken,
    signOut,
  }
}
