import { isTulaError, type TulaClient, type TulaError } from '@tula/core'
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react'

const TulaContext = createContext<TulaClient | null>(null)

/**
 * Props of {@link TulaProvider}.
 *
 * @example
 * ```tsx
 * const props: TulaProviderProps = { client: tula, children: <Screens /> }
 * ```
 */
export interface TulaProviderProps {
  /**
   * The client, from `createTulaExpoClient`. Create it once, outside any component: a new
   * client would have lost the access token the old one holds in memory.
   */
  client: TulaClient
  /** The app. */
  children?: ReactNode
}

/** First retry of a failed `load()`, doubled each time up to {@link MAX_LOAD_RETRY_MS}. */
const LOAD_RETRY_MS = 2_000
const MAX_LOAD_RETRY_MS = 30_000

// One `load()` per client however many providers mount with it. React's StrictMode runs
// effects twice in development; without this the second run would send a second refresh.
const loading = new WeakMap<TulaClient, Promise<unknown>>()

function loadOnce(client: TulaClient): Promise<unknown> {
  let pending = loading.get(client)
  if (!pending) {
    pending = client.load().finally(() => loading.delete(client))
    loading.set(client, pending)
  }
  return pending
}

/** Why a client's last `load()` failed, and who wants to know when that changes. */
interface LoadFailure {
  error: TulaError | null
  readonly listeners: Set<() => void>
}

// Per client, like `loading`: two providers with one client share one load and one answer.
const failures = new WeakMap<TulaClient, LoadFailure>()

function failureOf(client: TulaClient): LoadFailure {
  let failure = failures.get(client)
  if (!failure) {
    failure = { error: null, listeners: new Set() }
    failures.set(client, failure)
  }
  return failure
}

function setLoadError(client: TulaClient, error: TulaError | null): void {
  const failure = failureOf(client)
  if (failure.error === error) {
    return
  }
  failure.error = error
  for (const notify of failure.listeners) {
    notify()
  }
}

/**
 * Why the provider's last `load()` of a client failed, for a component.
 *
 * The provider keeps trying whatever the reason, so this is not a state to act on by
 * itself; it is what lets a screen say more than "loading" when the reason will not go away
 * on its own (a wrong publishable key, a wrong `baseUrl`).
 *
 * @param client - The client.
 * @returns The client's own error of the last failed try, or `null` when the last try
 *   succeeded or none has failed.
 */
export function useLoadError(client: TulaClient): TulaError | null {
  const subscribe = useCallback(
    (notify: () => void) => {
      const { listeners } = failureOf(client)
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    [client]
  )
  return useSyncExternalStore(
    subscribe,
    () => failureOf(client).error,
    () => null
  )
}

/**
 * Makes a Tula client available to the hooks below it, and finds out who is signed in.
 *
 * After mounting it calls the client's `load()` once: the refresh token is read from the
 * secure store and exchanged, and the state becomes `signed-in` or `signed-out`. While the
 * API cannot be reached, or the secure store cannot be read (a locked device), the state
 * stays `loading` and `load()` is tried again with a growing delay: a failure there never
 * signs anybody out. It tries again whatever the failure was, also one that will not go
 * away by itself (a wrong publishable key): `useAuth().loadError` is the last try's error,
 * so that an app can say so. It draws nothing of its own.
 *
 * @param props - The client and the app.
 * @returns The provider.
 *
 * @example
 * ```tsx
 * const tula = createTulaExpoClient({ publishableKey, baseUrl })
 *
 * export default function App() {
 *   return (
 *     <TulaProvider client={tula}>
 *       <Screens />
 *     </TulaProvider>
 *   )
 * }
 * ```
 */
export function TulaProvider(props: TulaProviderProps): ReactElement {
  const { client, children } = props

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = LOAD_RETRY_MS
    const attempt = () => {
      if (stopped || client.state.status !== 'loading') {
        return
      }
      loadOnce(client).then(
        () => setLoadError(client, null),
        (error: unknown) => {
          // Offline, the API down, the secure store locked, a key the API refuses: the state
          // stays `loading`. Which of them it was is handed to the app, never decided here:
          // every one is tried again. Only the client's own error is handed on: its code and
          // message are the client's words. (Its `cause` is whatever was thrown below it,
          // the secure store's own error among them: the hook's JSDoc says not to show it.)
          if (isTulaError(error)) {
            setLoadError(client, error)
          }
          if (!stopped) {
            timer = setTimeout(attempt, delay)
            delay = Math.min(delay * 2, MAX_LOAD_RETRY_MS)
          }
        }
      )
    }
    attempt()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [client])

  return createElement(TulaContext.Provider, { value: client }, children)
}

/**
 * The client of the nearest {@link TulaProvider}, for anything the other hooks do not cover.
 *
 * @returns The client.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * const tula = useTula()
 * const config = await tula.config.get()
 * ```
 */
export function useTula(): TulaClient {
  const client = useContext(TulaContext)
  if (!client) {
    throw new Error('@tula/expo: this hook must be used inside <TulaProvider>.')
  }
  return client
}
