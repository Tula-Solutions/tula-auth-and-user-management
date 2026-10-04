import { createTulaClient, type StepUpMethod, type TulaClient } from '@tula/core'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Appearance } from './appearance'
import { type Prompt, PromptHost, SignOutFailedDialog } from './components/prompts'
import { Root } from './components/ui'
import {
  type LocalizationOverrides,
  resolveLocalization,
  type TulaLocalization,
} from './localization'
import { go, type NavigationOptions } from './navigation'

/** What the provider shares with hooks and components. */
export interface TulaContextValue {
  /** The `@tula/core` client. */
  client: TulaClient
  /** The provider's appearance. */
  appearance: Appearance | undefined
  /** Every string, with the app's overrides applied. */
  localization: TulaLocalization
  /** The app's URLs and its `navigate` function. */
  navigation: NavigationOptions
  /** Dialogs the provider shows above the app. */
  prompts: Prompts
  /**
   * Sign out as the components do: go to the after-sign-out URL only once the server has been
   * told. When it could not be told, nothing navigates and the provider says, in a dialog with
   * "Try again", that the session may still be active on this device (the client itself is
   * signed out by then, so the component that asked is usually no longer on the page).
   *
   * @param redirectUrl - Where to go instead of the provider's `afterSignOutUrl`.
   * @returns `true` once signed out here and on the server; `false` when the server could not
   *   be told.
   */
  signOut(redirectUrl?: string): Promise<boolean>
}

/** The provider's dialogs: each returns a promise that settles when the user is done. */
export interface Prompts {
  /**
   * Ask the user to prove who they are (the step-up dialog).
   *
   * @param methods - What the server said this user can step up with.
   * @returns `true` once the session was stepped up; `false` when the user gave up, could not,
   *   or another prompt was already open.
   */
  stepUp(methods: readonly StepUpMethod[]): Promise<boolean>
  /**
   * Show backup codes, once, until the user says they saved them. The codes are held only
   * while the dialog is open.
   *
   * @param codes - The codes.
   * @returns Once the user has confirmed.
   */
  backupCodes(codes: readonly string[]): Promise<void>
}

const TulaContext = createContext<TulaContextValue | null>(null)

/**
 * Props of {@link TulaProvider}: either a publishable key and the API's URL (the provider
 * creates the client), or a client the app created itself.
 *
 * @example
 * ```tsx
 * const props: TulaProviderProps = {
 *   publishableKey: 'tula_pk_dev_…',
 *   baseUrl: 'https://auth.example.com',
 *   children: <App />,
 * }
 * ```
 */
export type TulaProviderProps = (
  | {
      /** The environment's publishable key (`tula_pk_<env>_…`). Safe to embed in an app. */
      publishableKey: string
      /** Where the Tula API is served, e.g. `https://auth.example.com`. */
      baseUrl: string
      client?: undefined
    }
  | {
      /** A client created with `createTulaClient`, for an app that also uses it directly. */
      client: TulaClient
      publishableKey?: undefined
      baseUrl?: undefined
    }
) &
  NavigationOptions & {
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
 * Makes Tula available to the hooks and components below it.
 *
 * Creates one `@tula/core` client (or takes yours) and, in the browser, calls `load()` once
 * after mounting to find out who is signed in. Nothing touches `window` during render, so the
 * provider can be rendered on a server: there the state is `loading`, and `<SignedIn>`,
 * `<SignedOut>` and the hooks answer accordingly until the browser takes over. If the API
 * cannot be reached, `load()` is tried again with a growing delay (and when the browser comes
 * back online); the state stays `loading` meanwhile.
 *
 * @param props - A publishable key and base URL (or a client), and optionally the app's URLs,
 *   a `navigate` function, an appearance and strings.
 * @returns The provider.
 * @throws TypeError for a secret key or a relative `baseUrl` (from `createTulaClient`).
 *
 * @example
 * ```tsx
 * import { SignedIn, SignedOut, SignIn, TulaProvider, UserButton } from '@tula/react'
 * import '@tula/react/styles.css'
 *
 * export function App() {
 *   return (
 *     <TulaProvider publishableKey='tula_pk_dev_…' baseUrl='https://auth.example.com'>
 *       <SignedOut>
 *         <SignIn signUpUrl='/sign-up' />
 *       </SignedOut>
 *       <SignedIn>
 *         <UserButton />
 *       </SignedIn>
 *     </TulaProvider>
 *   )
 * }
 * ```
 */
export function TulaProvider(props: TulaProviderProps) {
  const { children, appearance, localization: overrides } = props
  const {
    navigate,
    signInUrl,
    signUpUrl,
    afterSignInUrl,
    emailLinkUrl,
    oauthCallbackUrl,
    afterSignUpUrl,
    afterSignOutUrl,
    userProfileUrl,
  } = props

  // One client per key and URL, kept in a ref: `useMemo` may be recomputed at any time, and a
  // new client would have lost the access token it holds in memory.
  const created = useRef<{ key: string; client: TulaClient } | null>(null)
  let client: TulaClient
  if (props.client) {
    client = props.client
  } else {
    const key = `${props.baseUrl}|${props.publishableKey}`
    if (created.current?.key !== key) {
      created.current = {
        key,
        client: createTulaClient({ publishableKey: props.publishableKey, baseUrl: props.baseUrl }),
      }
    }
    client = created.current.client
  }

  const localization = useMemo(() => resolveLocalization(overrides), [overrides])
  const errors = localization.errors

  useEffect(() => {
    client.setMessages(errors)
  }, [client, errors])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = LOAD_RETRY_MS
    const attempt = () => {
      clearTimeout(timer)
      if (stopped || client.state.status !== 'loading') {
        return
      }
      loadOnce(client).catch(() => {
        // Offline, or the API is down: the state stays `loading`. Ask again later.
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
  }, [client])

  // What is being asked of the user above the app, if anything. The ref mirrors the state so
  // that a request made while one is open can be answered without waiting for a render.
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const open = useRef<Prompt | null>(null)
  const prompts = useMemo<Prompts>(() => {
    const show = (next: Prompt) => {
      open.current = next
      setPrompt(next)
    }
    return {
      stepUp: (methods) =>
        new Promise<boolean>((resolve) => {
          if (open.current) {
            resolve(false)
          } else {
            show({ kind: 'step-up', methods, resolve })
          }
        }),
      backupCodes: (codes) =>
        new Promise<void>((resolve) => {
          const current = open.current
          // Codes are shown once and cannot wait: they take the place of a step-up dialog.
          if (current?.kind === 'step-up') {
            current.resolve(false)
          }
          show({
            kind: 'backup-codes',
            codes,
            resolve: () => {
              if (current?.kind === 'backup-codes') {
                current.resolve()
              }
              resolve()
            },
          })
        }),
    }
  }, [])
  const closePrompt = () => {
    open.current = null
    setPrompt(null)
  }

  // A sign-out the server was not told about, and where it was going. Shown until a retry
  // gets through, the user closes it, or someone signs in.
  const [failedSignOut, setFailedSignOut] = useState<{ redirectUrl: string | undefined } | null>(
    null
  )
  const signOut = useCallback(
    async (redirectUrl?: string) => {
      try {
        await client.session.signOut()
      } catch {
        // The client is signed out, but the server may still hold the session and the browser
        // its cookie. Going on to "you are signed out" would be a claim nobody checked.
        setFailedSignOut({ redirectUrl })
        return false
      }
      setFailedSignOut(null)
      go(redirectUrl ?? afterSignOutUrl, navigate)
      return true
    },
    [client, navigate, afterSignOutUrl]
  )
  const closeFailedSignOut = useCallback(() => setFailedSignOut(null), [])

  const value = useMemo<TulaContextValue>(
    () => ({
      client,
      appearance,
      localization,
      prompts,
      signOut,
      navigation: {
        navigate,
        signInUrl,
        signUpUrl,
        afterSignInUrl,
        emailLinkUrl,
        oauthCallbackUrl,
        afterSignUpUrl,
        afterSignOutUrl,
        userProfileUrl,
      },
    }),
    [
      client,
      appearance,
      localization,
      prompts,
      signOut,
      navigate,
      signInUrl,
      signUpUrl,
      afterSignInUrl,
      emailLinkUrl,
      oauthCallbackUrl,
      afterSignUpUrl,
      afterSignOutUrl,
      userProfileUrl,
    ]
  )

  return (
    <TulaContext.Provider value={value}>
      {children}
      <PromptHost prompt={prompt} onClose={closePrompt} />
      {failedSignOut && prompt === null ? (
        <Root appearance={undefined}>
          <SignOutFailedDialog
            retry={() => signOut(failedSignOut.redirectUrl)}
            onClose={closeFailedSignOut}
          />
        </Root>
      ) : null}
    </TulaContext.Provider>
  )
}

/**
 * What the nearest {@link TulaProvider} shares.
 *
 * @returns The context value.
 * @throws Error when there is no provider above the caller.
 */
export function useTulaContext(): TulaContextValue {
  const value = useContext(TulaContext)
  if (!value) {
    throw new Error('@tula/react: this hook or component must be rendered inside <TulaProvider>.')
  }
  return value
}
