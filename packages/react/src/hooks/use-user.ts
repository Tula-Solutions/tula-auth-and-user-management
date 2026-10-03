import type { User } from '@tula/core'
import { useCallback, useEffect } from 'react'
import { useTulaContext } from '../context'
import { useAuthState } from './use-auth-state'

/** How long a signed-in state may lack its user before the hook fetches it again. */
const USER_REFETCH_DELAY_MS = 3_000

/**
 * What {@link useUser} returns.
 *
 * @example
 * ```ts
 * const { user }: UseUserResult = useUser()
 * ```
 */
export interface UseUserResult {
  /** Whether it is known who is signed in. */
  isLoaded: boolean
  /** Whether someone is signed in. */
  isSignedIn: boolean
  /**
   * The signed-in user, or `null` when signed out. Also `null` for a moment after signing in,
   * until the user has been fetched.
   */
  user: User | null
  /**
   * Fetch the user again (after your backend changed it, say).
   *
   * @returns The user.
   * @throws TulaError `auth.unauthenticated` when nobody is signed in.
   */
  reload(): Promise<User>
}

/**
 * The signed-in user.
 *
 * @returns The user and whether it is known yet.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function Greeting() {
 *   const { user } = useUser()
 *   return user ? <p>Hello, {user.firstName ?? user.email}</p> : null
 * }
 * ```
 */
export function useUser(): UseUserResult {
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const signedIn = state.status === 'signed-in'
  const user = signedIn ? state.user : null
  const sessionId = signedIn ? state.sessionId : null

  useEffect(() => {
    if (sessionId === null || user !== null) {
      return
    }
    // The client fetches the user itself right after a sign-in, so a missing user is normally
    // filled in within one request. If it is still missing after a while that fetch failed:
    // ask once more, quietly. (Asking at once would duplicate the client's own request.)
    const timer = setTimeout(() => {
      client.user.get().catch(() => undefined)
    }, USER_REFETCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [client, sessionId, user])

  const reload = useCallback(() => client.user.get(), [client])
  return { isLoaded: state.status !== 'loading', isSignedIn: signedIn, user, reload }
}
