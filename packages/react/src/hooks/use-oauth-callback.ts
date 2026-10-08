import {
  type Identity,
  isRetryableOAuthError,
  type OAuthCallbackOutcome,
  type TulaError,
} from '@tula/core'
import { useCallback, useEffect, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { type UseSignInResult, useSignIn } from './use-sign-in'

/**
 * Where the page an OAuth round trip ends on is:
 *
 * - `loading`: the ticket is being exchanged.
 * - `none`: the address carries no OAuth answer.
 * - `signed_in`: signed in.
 * - `needs_step`: the provider was accepted and something still stands before the session;
 *   `signIn.step` says what (`needs_second_factor`, `needs_factor_enrolment`) and `signIn`'s
 *   actions continue it.
 * - `linked`: a provider account was connected to the signed-in user; `identity` is it.
 * - `different_browser`: this browser did not start the sign-in. Nothing was completed.
 * - `refused`: it did not go through; `code` is the contract error code
 *   (`oauth.account_exists`, `oauth.access_denied`, …) and `message` its text.
 * - `error`: the API could not be asked; `error` says why. When `canRetry` is `true` the round
 *   trip is still open and `retry()` asks again.
 */
export type OAuthCallbackStatus =
  | 'loading'
  | 'none'
  | 'signed_in'
  | 'needs_step'
  | 'linked'
  | 'different_browser'
  | 'refused'
  | 'error'

/** What {@link useOAuthCallback} returns. */
export interface UseOAuthCallbackResult {
  status: OAuthCallbackStatus
  /** For `refused`: the contract error code. */
  code: string | null
  /** For `refused`: the code's text, from the provider's `localization.errors`. */
  message: string | null
  /** For `linked`: the connected account. */
  identity: Identity | null
  /** For `error`. */
  error: TulaError | null
  /**
   * For `error`: the request got no answer or was rate limited, and the round trip is still
   * open, so `retry()` can finish it. `false` for every other status.
   */
  canRetry: boolean
  /** Ask again after an `error` with `canRetry`. Does nothing while `loading`. */
  retry: () => void
  /** The sign-in the round trip belongs to: its step, and the actions that continue it. */
  signIn: UseSignInResult
}

type Settled = Pick<
  UseOAuthCallbackResult,
  'status' | 'code' | 'message' | 'identity' | 'error' | 'canRetry'
>

const blank = { code: null, message: null, identity: null, error: null, canRetry: false }

function settled(outcome: OAuthCallbackOutcome): Settled {
  switch (outcome.status) {
    case 'complete':
      return { ...blank, status: 'signed_in' }
    case 'needs_step':
      return { ...blank, status: 'needs_step' }
    case 'linked':
      return { ...blank, status: 'linked', identity: outcome.identity }
    case 'error':
      return { ...blank, status: 'refused', code: outcome.code, message: outcome.message }
    default:
      return { ...blank, status: outcome.status }
  }
}

/**
 * Finish an OAuth round trip on the page the API redirects to, for an app that draws that page
 * itself. `<OAuthCallback>` is this hook with screens.
 *
 * On mount it reads the ticket from the URL fragment (through `@tula/core`, which removes it
 * from the address before anything is sent) and exchanges it. A user who still has a second
 * factor to prove is not signed in: `status` is `needs_step` and `signIn` is positioned on
 * that step.
 *
 * An exchange that got no answer (or a rate limit) is an `error` with `canRetry`: `@tula/core`
 * still holds the round trip, and `retry()` exchanges it again.
 *
 * @returns The status, what it carries, a way to retry, and the sign-in.
 *
 * @example
 * ```tsx
 * function Landing() {
 *   const { status, message } = useOAuthCallback()
 *   if (status === 'loading') return <p>Signing you in…</p>
 *   return <p>{status === 'refused' ? message : status}</p>
 * }
 * ```
 */
export function useOAuthCallback(): UseOAuthCallbackResult {
  const { client } = useTulaContext()
  const signIn = useSignIn()
  const { adopt } = signIn
  const [result, setResult] = useState<Settled>({ ...blank, status: 'loading' })
  // Each retry is a new run of the effect below.
  const [round, setRound] = useState(0)

  useEffect(() => {
    let current = true
    // Named so that a retry, which changes nothing else, runs this again.
    void round
    // An effect that runs twice (StrictMode) shares one exchange: the client hands the second
    // call the first one's result.
    client.signIn.handleOAuthCallback().then(
      (outcome) => {
        if (!current) {
          return
        }
        if (outcome.status === 'complete' || outcome.status === 'needs_step') {
          adopt(outcome.flow)
        }
        setResult(settled(outcome))
      },
      (caught) => {
        if (current) {
          setResult({
            ...blank,
            status: 'error',
            error: toTulaError(caught),
            canRetry: isRetryableOAuthError(caught),
          })
        }
      }
    )
    return () => {
      current = false
    }
  }, [client, adopt, round])

  const retry = useCallback(() => {
    setResult((before) => (before.status === 'loading' ? before : { ...blank, status: 'loading' }))
    setRound((before) => before + 1)
  }, [])

  // The flow moves on from here (a second factor proven): its step is the truth.
  const status =
    result.status === 'needs_step' && signIn.step?.status === 'complete'
      ? 'signed_in'
      : result.status
  return { ...result, status, retry, signIn }
}
