import {
  type FlowStep,
  formatMessage,
  type PasswordResetFlow,
  type SecondFactorProof,
  type SignInFlow,
  type SignUpFlow,
  TulaError,
} from '@tula/core'
import { useCallback, useMemo } from 'react'
import { useTula } from '../context'
import { isEmailLink, openEmailLink, requestEmailLink } from '../email-link'
import { requireFreeSheet } from '../host'
import { type IdTokenSignInInput, signInWithIdToken } from '../id-token-sign-in'
import {
  type ProviderOutcome,
  type ProviderSignInInput,
  retryProviderSignIn,
  signInWithProvider,
} from '../provider-sign-in'
import {
  CALLED_OFF,
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
   * Ask for what proves a first factor (step `needs_first_factor`): a 6-digit code by email
   * (`email_code`), or by text message for a sign-in started with a phone number
   * (`sms_code`), or an emailed link (`email_link`). Nothing is sent until this is called,
   * and the answer is the same whether or not the address or number has an account. Call
   * it again for a fresh one (one a minute).
   *
   * An emailed link needs a client created with `emailLinkUrl` (`storage.failed` otherwise,
   * before any request): the link leads to that app link and nowhere else. The server
   * honours a link only in the client that asked for it, so hand the URL the app is then
   * opened with to `openEmailLink`. The same email carries a 6-digit code, which works on
   * any device: offer the field for it beside "check your email".
   *
   * @param input - The strategy.
   */
  prepareFirstFactor(input: {
    strategy: 'email_code' | 'sms_code' | 'email_link'
  }): Promise<FlowStep | null>
  /**
   * Open an emailed sign-in link the app was opened with (the URL from React Native's
   * `Linking`), and finish this sign-in with it. The step that follows is `complete`, or
   * what the server asks for next (a second factor).
   *
   * A URL that is not the client's app link with a link in its fragment is none of this
   * hook's business: the call resolves `null` and changes nothing, so every URL the app is
   * opened with can be handed over. A link is sent to the server only when this hook's
   * sign-in asked for it and the client still keeps its binding; otherwise the error is
   * `verification.different_browser`, **without a request**, and nothing is used up: a
   * link opened on another device, in another app, or after this app was ended and started
   * again. A link that is used, replaced or too old is `verification.expired`. Word both
   * by `error.code`: the client's sentences for them speak of a browser and of a code.
   *
   * A link the server took while the step that finishes could not be asked (no network)
   * leaves the error of that call: `finishEmailLink` asks again; the link itself is spent.
   *
   * **A link whose own request got no answer (`network.failed`, `network.timeout`) may
   * have been taken all the same.** The hook cannot tell and asks nothing on a guess: the
   * same URL opened again is then `verification.expired`, and `finishEmailLink` is what
   * signs in. Offer it after either error; where the link was not taken it changes
   * nothing. A refusal the server sent (`rate_limited`, `auth.method_disabled`) spent
   * nothing, and the same URL can be opened again.
   *
   * @param url - The whole URL the app was opened with, fragment included.
   */
  openEmailLink(url: string): Promise<FlowStep | null>
  /**
   * Ask the server once whether this sign-in's emailed link has been accepted, and finish
   * if it has. It is what to try after an `openEmailLink` whose last step got no answer,
   * after one whose own request got no answer (the link may have been taken), and after
   * `verification.expired` for a link this sign-in asked for (it may be this client that
   * used it). For a link nobody opened the step is unchanged and nothing is counted
   * against the sign-in, so it can be offered as a button.
   */
  finishEmailLink(): Promise<FlowStep | null>
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
  /**
   * Prove the second factor with a passkey (step `needs_second_factor` whose `options`
   * include `passkey`): the platform's passkey sheet opens. A dismissed sheet
   * submits nothing and sets `dismissed`, not `error`: the step is as it was.
   */
  submitSecondFactorWithPasskey(): Promise<FlowStep | null>
  /**
   * Sign in with a passkey, and nothing else: the platform's passkey sheet opens and the
   * user picks one. It is an attempt of its own (no identifier is asked for), and it
   * replaces the hook's attempt only when it goes through. A dismissed sheet is neither an
   * error nor a sign-in: `dismissed` is set, `error` is not, and the screen stays where it
   * was. A passkey this app's server does not know is `auth.invalid_credentials`.
   *
   * It needs a client created with `passkeys` (`passkey.unsupported` otherwise, before any
   * request). One passkey request runs at a time: while a sheet of this client is still
   * out the error is `flow.busy`, before any request, never `dismissed`.
   */
  withPasskey(): Promise<FlowStep | null>
  /**
   * Sign in with a provider: its page opens in the system browser, and the browser comes
   * back to `redirectUrl` (the app's custom scheme or app link, exactly as the environment
   * lists it). The step that follows is `complete`, or `needs_second_factor` for an
   * account that has one. A closed browser is neither an error nor a sign-in (`dismissed`).
   *
   * What comes back is exchanged only when it is that redirect URL and this client started
   * the round trip: anything else is `oauth.ticket_invalid` or `oauth.different_browser`
   * in `error`, without a request. A redirect URL the server refuses is
   * `request.redirect_not_allowed`, with the server's reason in `error.params.reason`.
   *
   * It needs a client created with `browser`.
   *
   * @param input - The provider and the redirect URL.
   */
  withProvider(input: ProviderSignInInput): Promise<FlowStep | null>
  /**
   * Try again a provider sign-in whose last step got no answer (`error.code` is
   * `network.failed`, `network.timeout` or `rate_limited` after `withProvider`): the
   * browser is not opened again. After a minute, or with nothing waiting, it fails with
   * `oauth.ticket_invalid`: start again.
   */
  retryProvider(): Promise<FlowStep | null>
  /**
   * Sign in with a provider's own sheet (Sign in with Apple, Google's account sheet): no
   * browser, no redirect URL. The server hands out a nonce, the sheet returns an ID token
   * that carries it, and the token is exchanged. The step that follows is `complete`, or
   * `needs_second_factor` for an account that has one. A dismissed sheet is neither an
   * error nor a sign-in (`dismissed`), and the action works again.
   *
   * It needs a client created with the provider's sheet (`google`, `apple`) and a build
   * and a device that have it: draw the control only where `useIdTokenProviders()` says
   * so. Without one the error is `storage.failed`, before any request. A token the server
   * refuses is `auth.invalid_credentials`; the server judges one token per sign-in, so
   * the next try starts again by itself.
   *
   * @param input - The provider.
   */
  withIdToken(input: IdTokenSignInInput): Promise<FlowStep | null>
}

/** The flow a provider round trip ended with, or what the hook says instead. */
function flowOf(outcome: ProviderOutcome): SignInFlow {
  switch (outcome.status) {
    case 'complete':
    case 'needs_step':
      return outcome.flow
    case 'cancelled':
      throw CALLED_OFF
    case 'error':
      throw new TulaError({ code: outcome.code, message: outcome.message })
    default: {
      // Refused here, or an answer that is not a sign-in's: nothing was completed.
      const code =
        outcome.status === 'refused' && outcome.reason === 'not_started_here'
          ? 'oauth.different_browser'
          : 'oauth.ticket_invalid'
      throw new TulaError({ code, message: formatMessage(code) })
    }
  }
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
    (input: { strategy: 'email_code' | 'sms_code' | 'email_link' }) =>
      act((flow) =>
        input.strategy === 'email_link'
          ? requestEmailLink(client, flow)
          : // Only the strategy: nothing else a caller's object may hold.
            flow.prepareFirstFactor({ strategy: input.strategy })
      ),
    [act, client]
  )
  const openLink = useCallback(
    async (url: string) => {
      if (!isEmailLink(client, url)) {
        // Some other link the app was opened with: not a sign-in's, and not an error.
        return null
      }
      return act(async (flow) => {
        const outcome = await openEmailLink(client, flow, url)
        if (outcome.status === 'accepted') {
          if (outcome.failure) {
            throw outcome.failure
          }
          return outcome.step
        }
        const code =
          outcome.status === 'expired' ? 'verification.expired' : 'verification.different_browser'
        throw new TulaError({ code, message: formatMessage(code) })
      }, NOBODYS_LINK)
    },
    [act, client]
  )
  const finishEmailLink = useCallback(
    () => act((flow) => flow.attemptFirstFactor({ strategy: 'email_link' })),
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
  const submitSecondFactorWithPasskey = useCallback(
    () =>
      act(async (flow) => {
        requireFreeSheet(client)
        return (await flow.submitSecondFactorWithPasskey()).step
      }),
    [act, client]
  )
  // Each is an attempt of its own: the hook's attempt is replaced only by one that exists.
  const withPasskey = useCallback(
    () =>
      begin(async () => {
        // Before the start: a sheet that is still out is no reason to make an attempt.
        requireFreeSheet(client)
        return client.signIn.withPasskey()
      }),
    [begin, client]
  )
  const withProvider = useCallback(
    (input: ProviderSignInInput) =>
      begin(async () => flowOf(await signInWithProvider(client, input))),
    [begin, client]
  )
  const retryProvider = useCallback(
    () => begin(async () => flowOf(await retryProviderSignIn(client))),
    [begin, client]
  )
  const withIdToken = useCallback(
    (input: IdTokenSignInInput) =>
      begin(async () => {
        const outcome = await signInWithIdToken(client, input)
        if (outcome.status === 'cancelled') {
          throw CALLED_OFF
        }
        return outcome.flow
      }),
    [begin, client]
  )
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return {
    ...state,
    ...enrolment,
    start,
    withPasskey,
    withProvider,
    retryProvider,
    withIdToken,
    submitSecondFactorWithPasskey,
    submitPassword,
    submitNewPassword,
    verifyEmail,
    resendCode,
    prepareFirstFactor,
    openEmailLink: openLink,
    finishEmailLink,
    attemptFirstFactor,
    prepareSecondFactor,
    submitSecondFactor,
  }
}

/**
 * What opening a link says when no sign-in is under way in this hook: the link is nobody's
 * here (asked for before the app was started again, or by another app).
 */
const NOBODYS_LINK = 'verification.different_browser'

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
  /**
   * Prove the second factor with a passkey (step `needs_second_factor` whose `options`
   * include `passkey`): the platform's passkey sheet opens. A dismissed sheet
   * submits nothing and sets `dismissed`, not `error`: the step is as it was.
   */
  submitSecondFactorWithPasskey(): Promise<FlowStep | null>
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
  const submitSecondFactorWithPasskey = useCallback(
    () =>
      act(async (flow) => {
        requireFreeSheet(client)
        return (await flow.submitSecondFactorWithPasskey()).step
      }),
    [act, client]
  )
  const enrolment = useMemo(() => enrolmentActions(act), [act])
  return {
    ...state,
    ...enrolment,
    start,
    submit,
    submitSecondFactorWithPasskey,
    resendCode,
    prepareSecondFactor,
    submitSecondFactor,
  }
}
