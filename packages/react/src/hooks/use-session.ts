import type { Session, TulaError } from '@tula/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from './use-auth-state'

/**
 * What {@link useSession} returns.
 *
 * @example
 * ```ts
 * const { sessions, revoke }: UseSessionResult = useSession()
 * ```
 */
export interface UseSessionResult {
  /** The current session's id, or `null` when signed out. */
  sessionId: string | null
  /**
   * The user's active sessions (their devices), most recently active first; `current` marks
   * this one. `null` until the first list has arrived.
   */
  sessions: Session[] | null
  /** Whether a list is being fetched. */
  isLoading: boolean
  /** Why the last list, revoke or revoke-others failed, or `null`. */
  error: TulaError | null
  /** Fetch the list again. */
  reload(): Promise<void>
  /**
   * Sign out one device. Revoking the current session signs this client out.
   *
   * @param sessionId - The session to end.
   * @returns Whether it worked; `error` says why when it did not.
   */
  revoke(sessionId: string): Promise<boolean>
  /**
   * Sign out every other device; this one stays signed in.
   *
   * @returns How many sessions ended, or `null` when it failed (see `error`).
   */
  revokeOthers(): Promise<number | null>
}

/**
 * The current session and the user's other devices: list them, sign one out, sign out all the
 * others. The list is fetched when the hook mounts with a signed-in user and after each change.
 *
 * @returns The sessions and the actions on them.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function Devices() {
 *   const { sessions, revoke } = useSession()
 *   return (
 *     <ul>
 *       {sessions?.map((session) => (
 *         <li key={session.id}>
 *           {session.userAgent} {session.current ? '(this device)' : null}
 *           {!session.current && <button onClick={() => revoke(session.id)}>Sign out</button>}
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */
export function useSession(): UseSessionResult {
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // One list request at a time: callers that ask while one is on its way share its answer.
  // (React's StrictMode runs the effect below twice in development; a refetch after a change
  // can coincide with the first load.)
  const inFlight = useRef<Promise<void> | null>(null)
  const reload = useCallback(() => {
    if (inFlight.current) {
      return inFlight.current
    }
    const run = async () => {
      setLoading(true)
      try {
        const list = await client.session.list()
        if (mounted.current) {
          setSessions(list)
          setError(null)
        }
      } catch (caught) {
        if (mounted.current) {
          setError(toTulaError(caught))
        }
      } finally {
        inFlight.current = null
        if (mounted.current) {
          setLoading(false)
        }
      }
    }
    inFlight.current = run()
    return inFlight.current
  }, [client])

  useEffect(() => {
    if (sessionId === null) {
      setSessions(null)
      return
    }
    void reload()
  }, [sessionId, reload])

  const revoke = useCallback(
    async (id: string) => {
      try {
        await client.session.revoke(id)
      } catch (caught) {
        if (mounted.current) {
          setError(toTulaError(caught))
        }
        return false
      }
      if (mounted.current && client.state.status === 'signed-in') {
        await reload()
      }
      return true
    },
    [client, reload]
  )

  const revokeOthers = useCallback(async () => {
    let ended: number
    try {
      ended = await client.session.revokeOthers()
    } catch (caught) {
      if (mounted.current) {
        setError(toTulaError(caught))
      }
      return null
    }
    if (mounted.current) {
      await reload()
    }
    return ended
  }, [client, reload])

  return { sessionId, sessions, isLoading, error, reload, revoke, revokeOthers }
}
