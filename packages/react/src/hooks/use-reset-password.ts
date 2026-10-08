import type { FlowStep, PasskeyRequest, PasswordResetFlow, SecondFactorProof } from '@tula/core'
import { useCallback, useMemo } from 'react'
import { useTulaContext } from '../context'
import {
  enrolmentActions,
  type FactorEnrolmentHookActions,
  type FlowState,
  useFlowController,
} from './use-flow'

/**
 * What {@link useResetPassword} returns: the flow's state and the actions of a password
 * reset. Every action resolves with the next step, or `null` when it failed (the reason is in
 * `error`); none of them rejects.
 *
 * @example
 * ```ts
 * const reset: UseResetPasswordResult = useResetPassword()
 * ```
 */
export interface UseResetPasswordResult extends FlowState, FactorEnrolmentHookActions {
  /**
   * Start a reset: the server emails a 6-digit code. The answer is the same whether or not
   * the address has an account.
   *
   * @param input - The account's email address.
   */
  start(input: { email: string }): Promise<FlowStep | null>
  /**
   * Submit the emailed code and the new password together (step `needs_new_password`). A
   * completed reset signs the user in and ends their other sessions.
   *
   * @param input - The code and the new password.
   */
  submit(input: { code: string; password: string }): Promise<FlowStep | null>
  /** Email a fresh code. The server allows one a minute (`rate_limited` with `retryAfterMs`). */
  resendCode(): Promise<FlowStep | null>
  /**
   * Prove a second factor (step `needs_second_factor`): the reset stored the new password,
   * and the user's authenticator code or a backup code signs them in.
   *
   * @param input - The method and its code.
   */
  submitSecondFactor(input: SecondFactorProof): Promise<FlowStep | null>
  /**
   * Prove a passkey as the second factor (step `needs_second_factor` whose `options` include
   * `passkey`): runs the browser's passkey dialog and submits what it returns.
   *
   * @param request - `signal`: ends the dialog.
   */
  submitSecondFactorWithPasskey(request?: Pick<PasskeyRequest, 'signal'>): Promise<FlowStep | null>
}

/**
 * A headless password reset: the server's current step, a pending flag, a typed error and the
 * actions, for building your own screens. `<SignIn>`'s "Forgot password?" is built on it.
 *
 * @returns The flow's state and actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function MyReset() {
 *   const reset = useResetPassword()
 *   if (reset.step?.status === 'needs_new_password') {
 *     return <NewPasswordForm onSubmit={(code, password) => reset.submit({ code, password })} />
 *   }
 *   return <EmailForm onSubmit={(email) => reset.start({ email })} />
 * }
 * ```
 */
export function useResetPassword(): UseResetPasswordResult {
  const { client } = useTulaContext()
  const {
    start: begin,
    act,
    watch: _watch,
    adopt: _adopt,
    ...state
  } = useFlowController<PasswordResetFlow>()
  const start = useCallback(
    (input: { email: string }) => begin(() => client.resetPassword.start(input)),
    [begin, client]
  )
  const submit = useCallback(
    (input: { code: string; password: string }) => act((flow) => flow.submit(input)),
    [act]
  )
  const resendCode = useCallback(() => act((flow) => flow.resendCode()), [act])
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
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return {
    ...state,
    ...enrolment,
    start,
    submit,
    resendCode,
    submitSecondFactor,
    submitSecondFactorWithPasskey,
  }
}
