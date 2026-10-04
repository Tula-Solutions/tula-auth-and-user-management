import type { AuthState, TulaClient } from '@tula/core'
import { useCallback, useSyncExternalStore } from 'react'

/** What a server render (and the first browser render, to match it) sees. */
const LOADING: AuthState = Object.freeze({ status: 'loading' })

/**
 * Subscribe a component to the client's authentication state.
 *
 * The client keeps the same state object until something changes, and a token refresh is not
 * a change, so the snapshot is stable and components do not re-render every minute.
 *
 * @param client - The client.
 * @returns The current state; during server rendering and hydration the client's
 *   `serverState`, or `loading` when it has none.
 */
export function useAuthState(client: TulaClient): AuthState {
  const subscribe = useCallback((notify: () => void) => client.onChange(notify), [client])
  return useSyncExternalStore(
    subscribe,
    () => client.state,
    // The server and hydration: what the server knew (a framework integration says), else
    // `loading`. Never `client.state`: a client that loaded before hydration would not match
    // the server's HTML.
    () => client.serverState ?? LOADING
  )
}
