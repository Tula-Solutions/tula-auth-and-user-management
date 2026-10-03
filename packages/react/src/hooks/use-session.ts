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

  /** The session the client has right now, read at the moment of asking (not from a render). */
  const current = useCallback(
    () => (client.state.status === 'signed-in' ? client.state.sessionId : null),
    [client]
  )

  // One list request at a time per session: callers that ask while one is on its way share
  // its answer. (React's StrictMode runs the effect below twice in development; a refetch
  // after a change can coincide with the first load.) A request belongs to the session it
  // was started under: it is never shared with, and its result never shown to, another one.
  const inFlight = useRef<{ sessionId: string; done: Promise<void> } | null>(null)
  const reload = useCallback(() => {
    const startedFor = current()
    if (startedFor === null) {
      return Promise.resolve()
    }
    if (inFlight.current?.sessionId === startedFor) {
      // The request being joined is still running, so this session's list is loading, whatever
      // the flag was reset to since it started: under StrictMode the effect below runs twice,
      // and its second run clears the flag before joining the first run's request.
      setLoading(true)
      return inFlight.current.done
    }
    /** Still mounted, and still the session this request was made for. */
    const stillWanted = () => mounted.current && current() === startedFor
    const run = async () => {
      setLoading(true)
      try {
        const list = await client.session.list()
        if (stillWanted()) {
          setSessions(list)
          setError(null)
        }
      } catch (caught) {
        if (stillWanted()) {
          setError(toTulaError(caught))
        }
      } finally {
        if (inFlight.current?.done === done) {
          inFlight.current = null
        }
        if (stillWanted()) {
          setLoading(false)
        }
      }
    }
    const done = run()
    inFlight.current = { sessionId: startedFor, done }
    return done
  }, [client, current])

  useEffect(() => {
    // Whoever was signed in before, their list, error and pending flag are not this
    // session's: start clean, then ask for this one's.
    setSessions(null)
    setError(null)
    setLoading(false)
    if (sessionId !== null) {
      void reload()
    }
  }, [sessionId, reload])

  const revoke = useCallback(
    async (id: string) => {
      const startedFor = current()
      try {
        await client.session.revoke(id)
      } catch (caught) {
        if (mounted.current && current() === startedFor) {
          setError(toTulaError(caught))
        }
        return false
      }
      if (mounted.current && current() === startedFor) {
        await reload()
      }
      return true
    },
    [client, current, reload]
  )

  const revokeOthers = useCallback(async () => {
    const startedFor = current()
    let ended: number
    try {
      ended = await client.session.revokeOthers()
    } catch (caught) {
      if (mounted.current && current() === startedFor) {
        setError(toTulaError(caught))
      }
      return null
    }
    if (mounted.current && current() === startedFor) {
      await reload()
    }
    return ended
  }, [client, current, reload])

  return { sessionId, sessions, isLoading, error, reload, revoke, revokeOthers }
}
