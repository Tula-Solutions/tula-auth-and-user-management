import type { TulaClient } from '@tula/core'
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
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

/**
 * Makes a Tula client available to the hooks below it, and finds out who is signed in.
 *
 * After mounting it calls the client's `load()` once: the refresh token is read from the
 * secure store and exchanged, and the state becomes `signed-in` or `signed-out`. While the
 * API cannot be reached, or the secure store cannot be read (a locked device), the state
 * stays `loading` and `load()` is tried again with a growing delay: a failure there never
 * signs anybody out. It draws nothing of its own.
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
      loadOnce(client).catch(() => {
        // Offline, the API down, or the secure store locked: the state stays `loading`.
        if (!stopped) {
          timer = setTimeout(attempt, delay)
          delay = Math.min(delay * 2, MAX_LOAD_RETRY_MS)
        }
      })
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
