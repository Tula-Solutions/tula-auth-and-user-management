'use client'

import { type AuthState, createTulaClient, type TulaClient, type User } from '@tula/core'
import {
  type Appearance,
  type LocalizationOverrides,
  type NavigationOptions,
  TulaProvider as ReactTulaProvider,
} from '@tula/react'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect, useRef } from 'react'
import { DEFAULT_HANDLER_PATH } from './paths'

/**
 * What the server knows about the session when it renders the page: pass `auth()`'s result so
 * that the first paint, on the server and in the browser, already shows the right state.
 *
 * @example
 * ```tsx
 * const { sessionId } = await auth()
 * const initialState = sessionId ? { sessionId, user: await currentUser() } : null
 * ```
 */
export interface InitialAuthState {
  /** The session's id, from `auth()`. */
  sessionId: string
  /** The user, from `currentUser()`, when the layout fetched it. */
  user?: User | null
}

/**
 * Props of {@link TulaProvider}.
 *
 * @example
 * ```tsx
 * const props: TulaProviderProps = {
 *   publishableKey: process.env.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY ?? '',
 *   initialState: null,
 *   children: <App />,
 * }
 * ```
 */
export interface TulaProviderProps extends NavigationOptions {
  /** The environment's publishable key (`tula_pk_<env>_…`). Safe to embed in a page. */
  publishableKey: string
  /** Where the route handler is mounted on this origin. Defaults to `/api/tula`. */
  path?: string
  /**
   * The server's view of the session: `{ sessionId, user? }`, `null` for signed out, or left
   * out when the server did not look (the state is then `loading` until the browser asks).
   */
  initialState?: InitialAuthState | null
  /** The session profile to ask for when signing in. */
  sessionProfile?: string
  /** Theme tokens, colour scheme and class names for every component. */
  appearance?: Appearance
  /** Strings to change or translate. */
  localization?: LocalizationOverrides
  /** The app. */
  children?: ReactNode
}

/** First retry of a failed `load()`, doubled each time up to {@link MAX_LOAD_RETRY_MS}. */
const LOAD_RETRY_MS = 2_000
const MAX_LOAD_RETRY_MS = 30_000

/** Who a state is about: a session id, `null` for nobody, `undefined` while unknown. */
function identity(state: AuthState | undefined): string | null | undefined {
  if (!state || state.status === 'loading') {
    return undefined
  }
  return state.status === 'signed-in' ? state.sessionId : null
}

/** What the provider and the view share: the router, and whether a sign-out is under way. */
interface Shared {
  refresh(): void
  signingOut: number
}

/**
 * The client the components get: the app's client, seen through the server's eyes.
 *
 * - With a `hint`, it answers with the server's state until the client knows its own. The
 *   client itself starts at `loading` and learns the truth from its first refresh; the view
 *   shows `hint` meanwhile (and as `serverState`, which is what server rendering and
 *   hydration read), then the client's own state for good.
 * - `session.signOut()` re-renders the Server Components once the sign-out has reached the
 *   server. The client is signed out locally first, while the cookies are still there: a
 *   re-render at that moment would show the signed-in page again.
 */
function createView(inner: TulaClient, hint: AuthState | undefined, shared: Shared): TulaClient {
  const session: TulaClient['session'] = {
    ...inner.session,
    async signOut() {
      shared.signingOut += 1
      try {
        await inner.session.signOut()
      } finally {
        shared.signingOut -= 1
        shared.refresh()
      }
    },
  }
  return Object.create(inner, {
    session: { value: session },
    ...(hint && {
      state: { get: () => (inner.state.status === 'loading' ? hint : inner.state) },
      serverState: { value: hint },
    }),
  }) as TulaClient
}

/**
 * Makes Tula available to the components and hooks below it, in a Next.js app.
 *
 * It creates one `@tula/core` client that talks to the route handler on the app's own origin
 * (`/api/tula`), never to the API's host: session cookies are first-party and `HttpOnly`, the
 * access token lives in memory, and refreshes stay single-flight through the handler. Pass
 * the server's `initialState` and the first paint is right on both sides of hydration.
 * Navigation goes through the App Router, and when someone signs in or out the router is
 * refreshed so that Server Components render again for the new session.
 *
 * @param props - The publishable key, the server's initial state and the app's URLs.
 * @returns The provider.
 * @throws TypeError for a key that is not a publishable key (from `createTulaClient`).
 *
 * @example
 * ```tsx
 * // app/layout.tsx (a Server Component)
 * import { TulaProvider } from '@tula/nextjs'
 * import { auth } from '@tula/nextjs/server'
 * import '@tula/react/styles.css'
 *
 * export default async function RootLayout({ children }: { children: React.ReactNode }) {
 *   const { sessionId } = await auth()
 *   return (
 *     <html lang='en'>
 *       <body>
 *         <TulaProvider
 *           publishableKey={process.env.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY ?? ''}
 *           initialState={sessionId ? { sessionId } : null}
 *           signInUrl='/sign-in'
 *           afterSignOutUrl='/'
 *         >
 *           {children}
 *         </TulaProvider>
 *       </body>
 *     </html>
 *   )
 * }
 * ```
 */
export function TulaProvider(props: TulaProviderProps) {
  const {
    publishableKey,
    path = DEFAULT_HANDLER_PATH,
    initialState,
    sessionProfile,
    children,
    ...rest
  } = props
  const router = useRouter()

  // One client per key and path, kept in a ref: a new client would have lost the access token
  // it holds in memory. The origin is the page's own; while rendering on the server there is
  // none, and no request is made there either.
  const shared = useRef<Shared>({ refresh: () => undefined, signingOut: 0 })
  shared.current.refresh = () => router.refresh()
  const created = useRef<{
    key: string
    inner: TulaClient
    view: TulaClient
    hinted: boolean
  } | null>(null)
  const key = `${publishableKey}|${path}|${sessionProfile ?? ''}`
  if (created.current?.key !== key) {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    const inner = createTulaClient({
      publishableKey,
      baseUrl: `${origin}/${path.replace(/^\/+|\/+$/g, '')}`,
      ...(sessionProfile !== undefined && { sessionProfile }),
    })
    const hint: AuthState | undefined =
      initialState === undefined
        ? undefined
        : initialState === null
          ? Object.freeze({ status: 'signed-out' })
          : Object.freeze({
              status: 'signed-in',
              sessionId: initialState.sessionId,
              user: initialState.user ?? null,
            })
    created.current = {
      key,
      inner,
      view: createView(inner, hint, shared.current),
      hinted: hint !== undefined,
    }
  }
  const { inner, view, hinted } = created.current

  // With a server state the view never says `loading`, so `@tula/react`'s provider does not
  // start the client: do it here, with the same patience for an API that is down.
  useEffect(() => {
    if (!hinted) {
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = LOAD_RETRY_MS
    const attempt = () => {
      clearTimeout(timer)
      if (stopped || inner.state.status !== 'loading') {
        return
      }
      inner.load().catch(() => {
        if (!stopped) {
          timer = setTimeout(attempt, delay)
          delay = Math.min(delay * 2, MAX_LOAD_RETRY_MS)
        }
      })
    }
    attempt()
    window.addEventListener('online', attempt)
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('online', attempt)
    }
  }, [inner, hinted])

  // Server Components were rendered for one session. When the browser's client finds itself
  // in another (signed in, or signed out by the server), render them again. A sign-out made
  // here is the exception: `signOut()` above re-renders when the server knows.
  const shown = useRef(identity(view.serverState))
  useEffect(
    () =>
      inner.onChange((state) => {
        const now = identity(state)
        if (now === undefined) {
          return
        }
        const before = shown.current
        shown.current = now
        if (before !== undefined && before !== now && shared.current.signingOut === 0) {
          shared.current.refresh()
        }
      }),
    [inner]
  )

  return (
    <ReactTulaProvider client={view} navigate={(url) => router.push(url)} {...rest}>
      {children}
    </ReactTulaProvider>
  )
}
