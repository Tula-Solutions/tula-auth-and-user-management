import type { FlowStep, PasswordResetFlow } from '@tula/core'
import { useCallback } from 'react'
import { useTulaContext } from '../context'
import { type FlowState, useFlowController } from './use-flow'

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
export interface UseResetPasswordResult extends FlowState {
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
  const { start: begin, act, ...state } = useFlowController<PasswordResetFlow>()
  const start = useCallback(
    (input: { email: string }) => begin(() => client.resetPassword.start(input)),
    [begin, client]
  )
  const submit = useCallback(
    (input: { code: string; password: string }) => act((flow) => flow.submit(input)),
    [act]
  )
  const resendCode = useCallback(() => act((flow) => flow.resendCode()), [act])
  return { ...state, start, submit, resendCode }
}
