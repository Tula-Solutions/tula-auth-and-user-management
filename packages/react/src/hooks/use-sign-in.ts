import type { FlowStep, SignInFlow } from '@tula/core'
import { useCallback } from 'react'
import { useTulaContext } from '../context'
import { type FlowState, useFlowController } from './use-flow'

/**
 * What {@link useSignIn} returns: the flow's state and the actions of a sign-in. Every action
 * resolves with the next step, or `null` when it failed (the reason is in `error`); none of
 * them rejects.
 *
 * @example
 * ```ts
 * const signIn: UseSignInResult = useSignIn()
 * ```
 */
export interface UseSignInResult extends FlowState {
  /**
   * Start a sign-in. The answer depends only on the environment's settings, never on the
   * identifier: `needs_password`, or `needs_first_factor` with the strategies on offer.
   *
   * @param input - The user's email address.
   */
  start(input: { identifier: string }): Promise<FlowStep | null>
  /**
   * Submit the password (step `needs_password`, or `needs_first_factor` offering `password`).
   * A wrong email or password is `auth.invalid_credentials` alike; repeated failures lock the
   * account for a while (`rate_limited` with `retryAfterMs`).
   *
   * @param input - The password.
   */
  submitPassword(input: { password: string }): Promise<FlowStep | null>
  /**
   * Submit the emailed 6-digit code (step `needs_email_verification`).
   *
   * @param input - The code.
   */
  verifyEmail(input: { code: string }): Promise<FlowStep | null>
  /** Email a fresh code. The server allows one a minute (`rate_limited` with `retryAfterMs`). */
  resendCode(): Promise<FlowStep | null>
  /**
   * Ask for the email that proves an email first factor (step `needs_first_factor` offering
   * `email_code` or `email_link`): a 6-digit code, and for `email_link` also a link to
   * `redirectUrl` that works only in this browser. `redirectUrl` must be one of the
   * environment's allowed redirect URLs, exactly. Call it again for a fresh email (one a
   * minute).
   *
   * @param input - The strategy, and for a link the page it leads to.
   */
  prepareFirstFactor(
    input: { strategy: 'email_code' } | { strategy: 'email_link'; redirectUrl: string }
  ): Promise<FlowStep | null>
  /**
   * Submit the emailed sign-in code.
   *
   * @param input - The strategy and the code.
   */
  attemptFirstFactor(input: { strategy: 'email_code'; code: string }): Promise<FlowStep | null>
  /**
   * Wait for the emailed link to be opened in this browser, and finish the sign-in here when
   * it is. It does not set `isPending`, and the other actions keep working while it waits.
   * Abort the signal when the screen goes away.
   *
   * @param options - `signal`: stop waiting.
   */
  waitForEmailLink(options?: { signal?: AbortSignal }): Promise<FlowStep | null>
  /**
   * Whether an emailed link can be used in this browser: it needs storage the browser's tabs
   * share, which some privacy modes and sandboxed frames refuse. Offer only the code where it
   * cannot.
   */
  canUseEmailLink(): boolean
}

/**
 * A headless sign-in: the server's current step, a pending flag, a typed error and the
 * actions, for building your own screens. `<SignIn>` is built on it.
 *
 * When the step is `complete` the client is signed in and `useAuth()` says so.
 *
 * @returns The flow's state and actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function MySignIn() {
 *   const signIn = useSignIn()
 *   const [email, setEmail] = useState('')
 *   const [password, setPassword] = useState('')
 *   switch (signIn.step?.status) {
 *     case undefined:
 *       return <EmailForm value={email} onChange={setEmail} onSubmit={() => signIn.start({ identifier: email })} />
 *     case 'needs_password':
 *       return <PasswordForm error={signIn.error?.message} onSubmit={() => signIn.submitPassword({ password })} />
 *     case 'complete':
 *       return <p>Signed in.</p>
 *     default:
 *       return <p>This sign-in step is not supported by this version of the app.</p>
 *   }
 * }
 * ```
 */
export function useSignIn(): UseSignInResult {
  const { client } = useTulaContext()
  const { start: begin, act, watch, ...state } = useFlowController<SignInFlow>()
  const start = useCallback(
    (input: { identifier: string }) => begin(() => client.signIn.start(input)),
    [begin, client]
  )
  const submitPassword = useCallback(
    (input: { password: string }) => act((flow) => flow.submitPassword(input)),
    [act]
  )
  const verifyEmail = useCallback(
    (input: { code: string }) => act((flow) => flow.verifyEmail(input)),
    [act]
  )
  const resendCode = useCallback(() => act((flow) => flow.resendCode()), [act])
  const prepareFirstFactor = useCallback(
    (input: { strategy: 'email_code' } | { strategy: 'email_link'; redirectUrl: string }) =>
      act((flow) => flow.prepareFirstFactor(input)),
    [act]
  )
  const attemptFirstFactor = useCallback(
    (input: { strategy: 'email_code'; code: string }) =>
      act((flow) => flow.attemptFirstFactor(input)),
    [act]
  )
  const waitForEmailLink = useCallback(
    (options?: { signal?: AbortSignal }) => watch((flow) => flow.waitForEmailLink(options)),
    [watch]
  )
  const canUseEmailLink = useCallback(() => client.signIn.canUseEmailLink(), [client])
  return {
    ...state,
    start,
    submitPassword,
    verifyEmail,
    resendCode,
    prepareFirstFactor,
    attemptFirstFactor,
    waitForEmailLink,
    canUseEmailLink,
  }
}
