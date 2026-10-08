import type { FlowStep, SignUpFlow } from '@tula/core'
import { useCallback, useMemo } from 'react'
import { useTulaContext } from '../context'
import {
  enrolmentActions,
  type FactorEnrolmentHookActions,
  type FlowState,
  useFlowController,
} from './use-flow'

/**
 * What {@link useSignUp} returns: the flow's state and the actions of a sign-up. Every action
 * resolves with the next step, or `null` when it failed (the reason is in `error`); none of
 * them rejects.
 *
 * @example
 * ```ts
 * const signUp: UseSignUpResult = useSignUp()
 * ```
 */
export interface UseSignUpResult extends FlowState, FactorEnrolmentHookActions {
  /**
   * Start a sign-up: the server checks the email and password and emails a 6-digit code. A
   * password the policy rejects fails with the first unmet rule's code, and `error.errors`
   * lists every unmet rule for the `password` field.
   *
   * `password` may be left out only where the environment makes it optional
   * (`useClientConfig()?.signUp?.password === 'optional'`); the account then signs in with an
   * emailed code.
   *
   * @param input - The new account's email, password and optional name.
   */
  start(input: {
    email: string
    password?: string
    firstName?: string
    lastName?: string
  }): Promise<FlowStep | null>
  /**
   * Submit the emailed 6-digit code (step `needs_email_verification`).
   *
   * @param input - The code.
   */
  verifyEmail(input: { code: string }): Promise<FlowStep | null>
  /** Email a fresh code. The server allows one a minute (`rate_limited` with `retryAfterMs`). */
  resendCode(): Promise<FlowStep | null>
}

/**
 * A headless sign-up: the server's current step, a pending flag, a typed error and the
 * actions, for building your own screens. `<SignUp>` is built on it.
 *
 * @returns The flow's state and actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function MySignUp() {
 *   const signUp = useSignUp()
 *   if (signUp.step?.status === 'needs_email_verification') {
 *     return <CodeForm sentTo={signUp.step.destination} onSubmit={(code) => signUp.verifyEmail({ code })} />
 *   }
 *   return <AccountForm errors={signUp.error?.errors} onSubmit={(values) => signUp.start(values)} />
 * }
 * ```
 */
export function useSignUp(): UseSignUpResult {
  const { client } = useTulaContext()
  const {
    start: begin,
    act,
    watch: _watch,
    adopt: _adopt,
    ...state
  } = useFlowController<SignUpFlow>()
  const start = useCallback(
    (input: { email: string; password?: string; firstName?: string; lastName?: string }) =>
      begin(() => client.signUp.start(input)),
    [begin, client]
  )
  const verifyEmail = useCallback(
    (input: { code: string }) => act((flow) => flow.verifyEmail(input)),
    [act]
  )
  const resendCode = useCallback(() => act((flow) => flow.resendCode()), [act])
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return { ...state, ...enrolment, start, verifyEmail, resendCode }
}
