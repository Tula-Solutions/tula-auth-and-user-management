import type { AuthState, TulaClient } from '@tula-tech/core'
import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import type { World } from '../sandbox'

/** The scheme the site is showing, which is the one the previewed component is drawn in. */
export type SiteScheme = 'light' | 'dark'

function readScheme(): SiteScheme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function subscribeScheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/**
 * The colour scheme of the site, following the header's toggle. The component is previewed in
 * it: one control for the whole page, and the same scheme the reader will see in their app.
 *
 * @returns `light` or `dark`.
 */
export function useSiteScheme(): SiteScheme {
  return useSyncExternalStore(subscribeScheme, readScheme, () => 'light')
}

/** Switch the site's theme with the header's own toggle, so that its choice is saved too. */
export function toggleSiteScheme(): void {
  document.getElementById('theme-toggle')?.click()
}

/**
 * Re-render when the sandbox's world changes (an email arrives, a session starts or ends).
 *
 * @param world - The sandbox state.
 * @returns A number that changes with each change, for effects that depend on it.
 */
export function useWorld(world: World): number {
  const [version, bump] = useReducer((count: number) => count + 1, 0)
  useEffect(() => world.subscribe(bump), [world])
  return version
}

/**
 * The sandbox client's auth state, live.
 *
 * @param client - The client.
 * @returns Its current state.
 */
export function useAuthState(client: TulaClient): AuthState {
  const subscribe = useCallback((listener: () => void) => client.onChange(listener), [client])
  return useSyncExternalStore(
    subscribe,
    () => client.state,
    () => client.state
  )
}

/**
 * A clock that ticks, for the authenticator's codes.
 *
 * @param everyMs - The tick, in milliseconds.
 * @returns The time of the last tick.
 */
export function useNow(everyMs: number): number {
  const [now, setNow] = useReducer(() => Date.now(), Date.now())
  useEffect(() => {
    const timer = setInterval(setNow, everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
