import type { FlowStep, PasskeyRequest, SecondFactorProof, SignInFlow } from '@tula/core'
import { useCallback, useMemo } from 'react'
import { useTulaContext } from '../context'
import {
  enrolmentActions,
  type FactorEnrolmentHookActions,
  type FlowState,
  useFlowController,
} from './use-flow'

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
export interface UseSignInResult extends FlowState, FactorEnrolmentHookActions {
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
   * Replace a password that has expired (step `needs_new_password` with `reason: 'expired'`)
   * and finish the sign-in. A refused password (`password.*`, `password.reused` for the
   * expired one) leaves the step as it is; `flow.invalid_step` means the password was
   * replaced some other way meanwhile, and the sign-in starts again.
   *
   * @param input - The new password.
   */
  submitNewPassword(input: { password: string }): Promise<FlowStep | null>
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
   * With `sms_code`, for a sign-in started with a phone number: a 6-digit code by text
   * message. The answer is the same whether or not the number can sign anyone in, and does
   * not say whether a message was sent.
   *
   * @param input - The strategy, and for a link the page it leads to.
   */
  prepareFirstFactor(
    input:
      | { strategy: 'email_code' }
      | { strategy: 'email_link'; redirectUrl: string }
      | { strategy: 'sms_code' }
  ): Promise<FlowStep | null>
  /**
   * Submit the emailed sign-in code, or the texted one (`sms_code`).
   *
   * @param input - The strategy and the code.
   */
  attemptFirstFactor(input: {
    strategy: 'email_code' | 'sms_code'
    code: string
  }): Promise<FlowStep | null>
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
  /**
   * Ask for the code of a second factor the server sends (step `needs_second_factor` whose
   * `options` include `sms_code`): a 6-digit code is texted to the account's phone number.
   * Nothing is sent until this is called.
   *
   * @param input - The method: `sms_code`.
   * @returns The step, now with `prepared`, or `null` when the request failed (see `error`).
   */
  prepareSecondFactor(input: { method: 'sms_code' }): Promise<FlowStep | null>
  /**
   * Prove a second factor (step `needs_second_factor`): the 6-digit code an authenticator app
   * shows, or an unused backup code.
   *
   * @param input - The method and its code.
   */
  submitSecondFactor(input: SecondFactorProof): Promise<FlowStep | null>
  /**
   * Prove a passkey as the second factor (step `needs_second_factor` whose `options` include
   * `passkey`): runs the browser's passkey dialog and submits what it returns. A dialog the
   * user dismissed leaves `error.code` at `passkey.cancelled`; nothing was sent.
   *
   * @param request - `signal`: ends the dialog.
   */
  submitSecondFactorWithPasskey(request?: Pick<PasskeyRequest, 'signal'>): Promise<FlowStep | null>
  /**
   * Sign in with a passkey: no identifier is needed, and the attempt is one of its own (a
   * sign-in already started here is left). Runs the browser's passkey dialog; a passkey
   * satisfies two-step verification, so the step it resolves with is usually `complete`.
   * Offer it only where `canUsePasskey()` is `true`.
   *
   * @param request - `signal`: ends the dialog.
   */
  withPasskey(request?: Pick<PasskeyRequest, 'signal'>): Promise<FlowStep | null>
  /**
   * Whether this browser can ask for a passkey at all. Call it after mount (in an effect or a
   * handler), never while rendering: a server has no WebAuthn.
   */
  canUsePasskey(): boolean
  /**
   * Continue a sign-in that was started elsewhere: the flow `signIn.handleOAuthCallback()` or
   * `signIn.withPasskey()` of the client answers with, positioned on its step. `step` becomes
   * that flow's, and the actions above act on it.
   */
  adopt(flow: SignInFlow): void
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
  const submitNewPassword = useCallback(
    (input: { password: string }) => act((flow) => flow.submitNewPassword(input)),
    [act]
  )
  const verifyEmail = useCallback(
    (input: { code: string }) => act((flow) => flow.verifyEmail(input)),
    [act]
  )
  const resendCode = useCallback(() => act((flow) => flow.resendCode()), [act])
  const prepareFirstFactor = useCallback(
    (
      input:
        | { strategy: 'email_code' }
        | { strategy: 'email_link'; redirectUrl: string }
        | { strategy: 'sms_code' }
    ) => act((flow) => flow.prepareFirstFactor(input)),
    [act]
  )
  const attemptFirstFactor = useCallback(
    (input: { strategy: 'email_code' | 'sms_code'; code: string }) =>
      act((flow) => flow.attemptFirstFactor(input)),
    [act]
  )
  const waitForEmailLink = useCallback(
    (options?: { signal?: AbortSignal }) => watch((flow) => flow.waitForEmailLink(options)),
    [watch]
  )
  const canUseEmailLink = useCallback(() => client.signIn.canUseEmailLink(), [client])
  const prepareSecondFactor = useCallback(
    (input: { method: 'sms_code' }) => act((flow) => flow.prepareSecondFactor(input)),
    [act]
  )
  const submitSecondFactor = useCallback(
    (input: SecondFactorProof) =>
      act((flow) => flow.submitSecondFactor(input).then((result) => result.step)),
    [act]
  )
  const submitSecondFactorWithPasskey = useCallback(
    (request?: Pick<PasskeyRequest, 'signal'>) =>
      act((flow) => flow.submitSecondFactorWithPasskey(request).then((result) => result.step)),
    [act]
  )
  const withPasskey = useCallback(
    (request?: Pick<PasskeyRequest, 'signal'>) =>
      begin(() => client.signIn.withPasskey({ signal: request?.signal })),
    [begin, client]
  )
  const canUsePasskey = useCallback(() => client.signIn.canUsePasskey(), [client])
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return {
    ...state,
    start,
    submitPassword,
    submitNewPassword,
    verifyEmail,
    resendCode,
    prepareFirstFactor,
    attemptFirstFactor,
    waitForEmailLink,
    canUseEmailLink,
    prepareSecondFactor,
    submitSecondFactor,
    submitSecondFactorWithPasskey,
    withPasskey,
    canUsePasskey,
    ...enrolment,
  }
}
