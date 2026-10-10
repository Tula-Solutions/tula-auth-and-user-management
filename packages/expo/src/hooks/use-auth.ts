import type { AuthState, TulaClient, User } from '@tula/core'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useTula } from '../context'

/** What a render without a client's state sees (React asks for it on a server). */
const LOADING: AuthState = Object.freeze({ status: 'loading' })

/**
 * Subscribe a component to the client's authentication state.
 *
 * The client keeps the same state object until something changes, and a token refresh is not
 * a change, so components do not re-render every minute.
 *
 * @param client - The client.
 * @returns The current state.
 */
export function useAuthState(client: TulaClient): AuthState {
  const subscribe = useCallback((notify: () => void) => client.onChange(notify), [client])
  return useSyncExternalStore(
    subscribe,
    () => client.state,
    () => LOADING
  )
}

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
   * need one instead of keeping the result: tokens last about a minute, and it must never be
   * put in storage, a log line or a URL.
   *
   * @returns The token, or `null` when nobody is signed in.
   * @throws TulaError when a needed refresh could not be made (offline, rate limited, the
   *   secure store locked). The user is still signed in.
   */
  getToken(): Promise<string | null>
  /**
   * Sign out: the app is signed out at once, the stored refresh token is deleted and the
   * server is told.
   *
   * @throws TulaError when the server could not be told or the stored token could not be
   *   deleted. The app is signed out all the same; call it again to tell the server.
   */
  signOut(): Promise<void>
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
 *   const { isSignedIn, getToken } = useAuth()
 *   const load = async () =>
 *     fetch('https://api.example.com/orders', {
 *       headers: { authorization: `Bearer ${await getToken()}` },
 *     })
 *   return isSignedIn ? <Button title='Load orders' onPress={load} /> : null
 * }
 * ```
 */
export function useAuth(): UseAuthResult {
  const client = useTula()
  const state = useAuthState(client)
  const getToken = useCallback(() => client.session.getToken(), [client])
  const signOut = useCallback(() => client.session.signOut(), [client])
  return {
    status: state.status,
    isLoaded: state.status !== 'loading',
    isSignedIn: state.status === 'signed-in',
    sessionId: state.status === 'signed-in' ? state.sessionId : null,
    getToken,
    signOut,
  }
}

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
 *   return user ? <Text>Hello, {user.firstName ?? user.email}</Text> : null
 * }
 * ```
 */
export function useUser(): UseUserResult {
  const client = useTula()
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
