import type {
  FlowStep,
  PasswordResetFlow,
  SecondFactorProof,
  SignInFlow,
  SignUpFlow,
} from '@tula/core'
import { useCallback, useMemo } from 'react'
import { useTula } from '../context'
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
   * (`signUp.password` of `useTula().config.get()`); the account then signs in with an
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
 * A headless sign-up: the screen to draw, a pending flag, a typed error and the actions.
 *
 * When the step is `complete` the client is signed in, the refresh token is in the secure
 * store, and `useAuth()` says so.
 *
 * @returns The flow's state and actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function SignUpScreen() {
 *   const signUp = useSignUp()
 *   switch (signUp.screen) {
 *     case null:
 *       return <AccountForm errors={signUp.error?.errors} onSubmit={(values) => signUp.start(values)} />
 *     case 'needs_email_verification':
 *       return <CodeForm onSubmit={(code) => signUp.verifyEmail({ code })} />
 *     default:
 *       return <NotSupported onRestart={signUp.reset} />
 *   }
 * }
 * ```
 */
export function useSignUp(): UseSignUpResult {
  const client = useTula()
  const { start: begin, act, ...state } = useFlowController<SignUpFlow>()
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
   * @param input - The user's email address (or, where a texted code is offered, their phone
   *   number).
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
   * and finish the sign-in. A refused password (`password.*`) leaves the step as it is.
   *
   * @param input - The new password.
   */
  submitNewPassword(input: { password: string }): Promise<FlowStep | null>
  /**
   * Submit the emailed 6-digit code of an address that was never verified (step
   * `needs_email_verification`).
   *
   * @param input - The code.
   */
  verifyEmail(input: { code: string }): Promise<FlowStep | null>
  /** Email a fresh code. The server allows one a minute (`rate_limited` with `retryAfterMs`). */
  resendCode(): Promise<FlowStep | null>
  /**
   * Ask for the code that proves a first factor (step `needs_first_factor` offering
   * `email_code` or `sms_code`): a 6-digit code by email, or by text message for a sign-in
   * started with a phone number. Nothing is sent until this is called, and the answer is the
   * same whether or not the address or number has an account. Call it again for a fresh code
   * (one a minute).
   *
   * An emailed link is not offered here: it is honoured only in the browser that asked for
   * it, and an app has none. The code in the same email is the way.
   *
   * @param input - The strategy.
   */
  prepareFirstFactor(input: { strategy: 'email_code' | 'sms_code' }): Promise<FlowStep | null>
  /**
   * Submit the emailed or texted sign-in code.
   *
   * @param input - The strategy and the code.
   */
  attemptFirstFactor(input: {
    strategy: 'email_code' | 'sms_code'
    code: string
  }): Promise<FlowStep | null>
  /**
   * Ask for the code of a second factor the server sends (step `needs_second_factor` whose
   * `options` include `sms_code`). Nothing is sent until this is called.
   *
   * @param input - The method: `sms_code`.
   */
  prepareSecondFactor(input: { method: 'sms_code' }): Promise<FlowStep | null>
  /**
   * Prove a second factor (step `needs_second_factor`): the code an authenticator app shows,
   * an unused backup code, or the texted code.
   *
   * @param input - The method and its code.
   */
  submitSecondFactor(input: SecondFactorProof): Promise<FlowStep | null>
}

/**
 * A headless sign-in: the screen to draw, a pending flag, a typed error and the actions.
 *
 * When the step is `complete` the client is signed in, the refresh token is in the secure
 * store, and `useAuth()` says so. A password or a code is the app's to hold: keep it in the
 * form's state only while the form is on screen.
 *
 * @returns The flow's state and actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function SignInScreen() {
 *   const signIn = useSignIn()
 *   switch (signIn.screen) {
 *     case null:
 *       return <EmailForm onSubmit={(identifier) => signIn.start({ identifier })} />
 *     case 'needs_password':
 *       return <PasswordForm error={signIn.error} onSubmit={(password) => signIn.submitPassword({ password })} />
 *     case 'needs_first_factor':
 *       return <EmailCodeForm onSend={() => signIn.prepareFirstFactor({ strategy: 'email_code' })} />
 *     default:
 *       return <NotSupported onRestart={signIn.reset} />
 *   }
 * }
 * ```
 */
export function useSignIn(): UseSignInResult {
  const client = useTula()
  const { start: begin, act, ...state } = useFlowController<SignInFlow>()
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
    (input: { strategy: 'email_code' | 'sms_code' }) =>
      act((flow) => flow.prepareFirstFactor(input)),
    [act]
  )
  const attemptFirstFactor = useCallback(
    (input: { strategy: 'email_code' | 'sms_code'; code: string }) =>
      act((flow) => flow.attemptFirstFactor(input)),
    [act]
  )
  const prepareSecondFactor = useCallback(
    (input: { method: 'sms_code' }) => act((flow) => flow.prepareSecondFactor(input)),
    [act]
  )
  const submitSecondFactor = useCallback(
    (input: SecondFactorProof) =>
      act((flow) => flow.submitSecondFactor(input).then((result) => result.step)),
    [act]
  )
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return {
    ...state,
    ...enrolment,
    start,
    submitPassword,
    submitNewPassword,
    verifyEmail,
    resendCode,
    prepareFirstFactor,
    attemptFirstFactor,
    prepareSecondFactor,
    submitSecondFactor,
  }
}

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
   * Start a reset: a 6-digit code is emailed if the address has an account. The answer is the
   * same either way.
   *
   * @param input - The account's email address.
   */
  start(input: { email: string }): Promise<FlowStep | null>
  /**
   * Submit the emailed code together with the new password (step `needs_new_password`). A
   * refused password leaves the code usable.
   *
   * @param input - The code and the new password.
   */
  submit(input: { code: string; password: string }): Promise<FlowStep | null>
  /** Email a fresh code. The server allows one a minute (`rate_limited` with `retryAfterMs`). */
  resendCode(): Promise<FlowStep | null>
  /**
   * Ask for the texted code of a second factor (step `needs_second_factor` whose `options`
   * include `sms_code`). Nothing is sent until this is called.
   *
   * @param input - The method: `sms_code`.
   */
  prepareSecondFactor(input: { method: 'sms_code' }): Promise<FlowStep | null>
  /**
   * Prove the second factor a reset stops at for an account that has one.
   *
   * @param input - The method and its code.
   */
  submitSecondFactor(input: SecondFactorProof): Promise<FlowStep | null>
}

/**
 * A headless password reset: the screen to draw, a pending flag, a typed error and the
 * actions. The user is signed in when it completes.
 *
 * @returns The flow's state and actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function ResetScreen() {
 *   const reset = useResetPassword()
 *   switch (reset.screen) {
 *     case null:
 *       return <EmailForm onSubmit={(email) => reset.start({ email })} />
 *     case 'needs_new_password':
 *       return <NewPasswordForm onSubmit={(code, password) => reset.submit({ code, password })} />
 *     default:
 *       return <NotSupported onRestart={reset.reset} />
 *   }
 * }
 * ```
 */
export function useResetPassword(): UseResetPasswordResult {
  const client = useTula()
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
  const prepareSecondFactor = useCallback(
    (input: { method: 'sms_code' }) => act((flow) => flow.prepareSecondFactor(input)),
    [act]
  )
  const submitSecondFactor = useCallback(
    (input: SecondFactorProof) =>
      act((flow) => flow.submitSecondFactor(input).then((result) => result.step)),
    [act]
  )
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return {
    ...state,
    ...enrolment,
    start,
    submit,
    resendCode,
    prepareSecondFactor,
    submitSecondFactor,
  }
}
