import type { TulaError } from '@tula/core'
import { useEffect, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from './use-auth-state'

/**
 * What became of the emailed sign-in link the page was opened with.
 *
 * - `loading`: being checked (and during server rendering).
 * - `signed_in`: the link was accepted and this tab is signed in.
 * - `verified`: the link was accepted; the tab that started the sign-in finishes it. This tab
 *   becomes `signed_in` if that happens while it is open.
 * - `different_browser`: opened in a browser that did not ask for the link. Nothing was used
 *   up: the link still works where it was asked for, and so does the code in the same email.
 * - `expired`: the link is used, replaced or older than ten minutes.
 * - `none`: the page's address carries no link.
 * - `error`: the API could not be reached or refused; see `error`.
 *
 * @example
 * ```ts
 * const status: EmailLinkStatus = useEmailLinkCallback().status
 * ```
 */
export type EmailLinkStatus =
  | 'loading'
  | 'none'
  | 'signed_in'
  | 'verified'
  | 'different_browser'
  | 'expired'
  | 'error'

/**
 * What {@link useEmailLinkCallback} returns.
 *
 * @example
 * ```ts
 * const { status, error }: UseEmailLinkCallbackResult = useEmailLinkCallback()
 * ```
 */
export interface UseEmailLinkCallbackResult {
  /** What became of the link. */
  status: EmailLinkStatus
  /** Why checking the link failed, when `status` is `error`. */
  error: TulaError | null
}

/**
 * Handle the emailed sign-in link the page was opened with: call it on the page your links
 * lead to (the `emailLinkUrl` you give `<SignIn>`). `<EmailLinkCallback>` is built on it.
 *
 * The link's token is taken from the URL fragment and removed from the address bar before
 * anything is sent. Opening a link never signs this tab in by itself: the tab that started the
 * sign-in finishes it, and this tab then shares its session.
 *
 * @returns The outcome, `loading` until it is known.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function LinkPage() {
 *   const { status } = useEmailLinkCallback()
 *   if (status === 'signed_in') return <Navigate to='/app' />
 *   if (status === 'different_browser') return <p>Open the link where you started, or use the code.</p>
 *   return <p>{status === 'loading' ? 'Signing you in…' : 'This link is no longer valid.'}</p>
 * }
 * ```
 */
export function useEmailLinkCallback(): UseEmailLinkCallbackResult {
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const [result, setResult] = useState<UseEmailLinkCallbackResult>({
    status: 'loading',
    error: null,
  })

  useEffect(() => {
    let current = true
    // `first`: the check made when the page appears. Later ones are made when only the
    // address's fragment changes, which loads nothing: a link pasted into, or followed in, a
    // tab that already shows this page. Without them that link's token would sit in the
    // address bar, unused and unremoved.
    const check = (first: boolean) => {
      // An effect that runs twice (StrictMode) shares one request: the client hands the
      // second call the first one's result.
      client.signIn.handleEmailLink().then(
        (outcome) => {
          // A fragment change that brought no link leaves what is shown alone.
          if (current && (first || outcome.status !== 'none')) {
            setResult({ status: outcome.status, error: null })
          }
        },
        (caught) => {
          if (current) {
            setResult({ status: 'error', error: toTulaError(caught) })
          }
        }
      )
    }
    check(true)
    const fragmentChanged = () => check(false)
    window.addEventListener('hashchange', fragmentChanged)
    return () => {
      current = false
      window.removeEventListener('hashchange', fragmentChanged)
    }
  }, [client])

  // The starting tab may finish after this hook stopped waiting for it, and a page opened
  // without a link may belong to someone who is signed in already.
  const arrived =
    state.status === 'signed-in' && (result.status === 'verified' || result.status === 'none')
  return arrived ? { status: 'signed_in', error: null } : result
}
