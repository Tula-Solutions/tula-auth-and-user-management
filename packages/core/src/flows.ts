import { clientError, formatMessage, type Messages, TulaError } from './errors'
import type { Schemas } from './generated/api.gen'
import { isSessionTokens, type SessionManager } from './session'
import type { Transport } from './transport'
import type { FlowKind, FlowStep } from './types'

type FlowAttempt = Schemas['FlowAttempt']

/**
 * What a flow looks like when it is logged or serialised: where it stands, and nothing that
 * could continue it. The attempt's secret is never part of it.
 *
 * @example
 * ```ts
 * JSON.stringify(flow) // {"id":"…","kind":"sign_in","step":{"status":"needs_password"},"expiresAt":"…"}
 * ```
 */
export interface FlowSnapshot<Kind extends FlowKind = FlowKind> {
  /** The attempt's id. Useless without the secret the flow object keeps to itself. */
  readonly id: string
  /** Which flow this is. */
  readonly kind: Kind
  /** The step the server is waiting on. Changes after every action. */
  readonly step: FlowStep
  /** When the attempt expires (ISO 8601). Start again after that. */
  readonly expiresAt: string
}

/**
 * What every flow object has: its snapshot, kept current, and a way to resend the code.
 *
 * A flow sends one action at a time. A second action while one is in flight is refused with
 * `flow.busy`, and any action once the step is `complete` with `flow.invalid_step`; both are
 * raised by the client (`status: 0`) without a request.
 */
interface Flow<Kind extends FlowKind> extends FlowSnapshot<Kind> {
  /**
   * Email a fresh code and retire the previous one. Limited by the server to one email a
   * minute per address.
   *
   * @returns The step, still waiting on the code.
   * @throws TulaError `rate_limited` (with `retryAfterMs`) when asked too soon.
   */
  resendCode(): Promise<FlowStep>
  /** @returns The flow's snapshot. The attempt's secret is never included. */
  toJSON(): FlowSnapshot<Kind>
}

/**
 * A sign-up in progress. `step` says what the server is waiting for; each action sends one
 * request and resolves with the next step. When the step is `complete` the client is signed in.
 *
 * @example
 * ```ts
 * const flow = await tula.signUp.start({ email, password })
 * // flow.step.status === 'needs_email_verification'
 * const step = await flow.verifyEmail({ code: '123456' })
 * // step.status === 'complete': tula.state.status is now 'signed-in'
 * ```
 */
export interface SignUpFlow extends Flow<'sign_up'> {
  /**
   * Submit the emailed 6-digit code (step `needs_email_verification`).
   *
   * @param input - The code.
   * @returns The next step: `complete` when the code is right.
   * @throws TulaError `verification.invalid_code`, `verification.expired` or
   *   `verification.too_many_attempts`.
   */
  verifyEmail(input: { code: string }): Promise<FlowStep>
}

/**
 * A sign-in in progress. `step` says what the server is waiting for; each action sends one
 * request and resolves with the next step. When the step is `complete` the client is signed in.
 *
 * A `needs_second_factor` step has no action yet: the API gets its second-factor route with
 * TOTP (plan step 1.8), and this flow gets `submitSecondFactor` with it.
 *
 * @example
 * ```ts
 * const flow = await tula.signIn.start({ identifier: email })
 * if (flow.step.status === 'needs_password') {
 *   const step = await flow.submitPassword({ password })
 *   if (step.status === 'needs_email_verification') {
 *     await flow.verifyEmail({ code })
 *   }
 * }
 * ```
 */
export interface SignInFlow extends Flow<'sign_in'> {
  /**
   * Submit the password (step `needs_password`, or `needs_first_factor` offering `password`).
   *
   * @param input - The password.
   * @returns The next step.
   * @throws TulaError `auth.invalid_credentials` for every wrong email or password alike, and
   *   `rate_limited` (with `retryAfterMs`) while the account is locked after repeated failures.
   */
  submitPassword(input: { password: string }): Promise<FlowStep>
  /**
   * Submit the emailed 6-digit code (step `needs_email_verification`: the account's address
   * was never verified).
   *
   * @param input - The code.
   * @returns The next step.
   * @throws TulaError `verification.invalid_code`, `verification.expired` or
   *   `verification.too_many_attempts`.
   */
  verifyEmail(input: { code: string }): Promise<FlowStep>
}

/**
 * A password reset in progress. The emailed code and the new password travel together, so a
 * verified attempt never works as a credential on its own. A completed reset ends the user's
 * other sessions and signs this client in.
 *
 * @example
 * ```ts
 * const flow = await tula.resetPassword.start({ email })
 * // flow.step.status === 'needs_new_password'
 * await flow.submit({ code: '123456', password: newPassword })
 * ```
 */
export interface PasswordResetFlow extends Flow<'password_reset'> {
  /**
   * Submit the emailed code and the new password (step `needs_new_password`).
   *
   * @param input - The code and the new password.
   * @returns The next step: `complete`, or `needs_second_factor` for a user who has one.
   * @throws TulaError `verification.*` for the code, or the first unmet password rule's code
   *   (`password.too_short`, …) with one field error per unmet rule.
   */
  submit(input: { code: string; password: string }): Promise<FlowStep>
}

/** What flows need from the client. */
export interface FlowContext {
  /** Sends requests. */
  transport: Transport
  /** Receives the tokens of a completed flow. */
  session: SessionManager
  /** The current locale table. */
  messages: () => Messages
}

/** What identifies an attempt to the API: its id in the path, its secret in a header. */
interface Binding {
  params: { attemptId: string }
  attemptSecret: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether an answer has what a flow object is built from: the attempt's id and a step with a
 * status, and, once the step is `complete`, session tokens the client can install. A 200 that
 * lacks them is not this API (a wrong base URL, a proxy's page) and must not become a flow.
 */
function isUsableAttempt(value: unknown): value is FlowAttempt {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    !isRecord(value.step) ||
    typeof value.step.status !== 'string'
  ) {
    return false
  }
  return value.step.status === 'complete'
    ? isSessionTokens(value.session)
    : value.session === undefined
}

/**
 * The state every flow object shares, held in a closure: the attempt as the server last
 * described it, and its secret. The secret is kept only here, in memory, and only until the
 * flow completes. It is never written to storage, and it is not a property of the flow object,
 * so it cannot end up in a log line, a serialised flow or an error.
 */
function createAttempt(context: FlowContext, started: FlowAttempt) {
  if (!isUsableAttempt(started) || !started.attemptSecret) {
    // Without the secret no later call can succeed; fail here rather than with a puzzling
    // `flow.not_found` on the next step.
    throw clientError('response.invalid', context.messages())
  }
  let secret: string | null = started.attemptSecret
  let busy = false
  // Only what the snapshot shows is kept: not the secret, and not a completed flow's tokens.
  let current: FlowSnapshot = {
    id: started.id,
    kind: started.kind,
    step: started.step,
    expiresAt: started.expiresAt,
  }

  async function accept(next: FlowAttempt): Promise<FlowStep> {
    // Checked before anything changes: an answer that cannot be used leaves the flow on the
    // step it was on, and signs nobody in.
    if (!isUsableAttempt(next)) {
      throw clientError('response.invalid', context.messages())
    }
    current = { id: next.id, kind: next.kind, step: next.step, expiresAt: next.expiresAt }
    if (next.step.status === 'complete') {
      // A completed attempt accepts nothing more, so its secret has no further use.
      secret = null
    }
    if (next.session) {
      await context.session.adopt(next.session)
    }
    return next.step
  }

  /** An error the flow raises itself, before any request (`status: 0`). */
  function refused(code: 'flow.invalid_step' | 'flow.busy'): TulaError {
    return new TulaError({ code, message: formatMessage(code, { messages: context.messages() }) })
  }

  return {
    snapshot: <Kind extends FlowKind>(): FlowSnapshot<Kind> => current as FlowSnapshot<Kind>,
    accept,
    /**
     * Send one call on this attempt and take the server's answer as the new step.
     *
     * Two things are refused here, without a request, because the client knows the answer
     * and a request could only do harm: an action on a completed flow (`flow.invalid_step`,
     * the code the server uses for the same thing), and a second action while one is still
     * being sent (`flow.busy`: a double-clicked button would otherwise spend two guesses, or
     * send two emails).
     *
     * @param send - Makes the call, given the attempt's id and secret.
     * @returns The next step.
     * @throws TulaError `flow.invalid_step` or `flow.busy`, both with `status: 0`.
     */
    async step(send: (binding: Binding) => Promise<FlowAttempt>): Promise<FlowStep> {
      if (secret === null) {
        throw refused('flow.invalid_step')
      }
      if (busy) {
        throw refused('flow.busy')
      }
      busy = true
      try {
        // A step can complete the flow and set the session (and, in a browser, its cookie).
        // It must not overlap a refresh of the session it replaces.
        await context.session.idle()
        return await accept(
          await send({ params: { attemptId: current.id }, attemptSecret: secret })
        )
      } finally {
        busy = false
      }
    },
  }
}

type Attempt = ReturnType<typeof createAttempt>

/**
 * Build a flow object: live `id`, `kind`, `step` and `expiresAt` properties, `toJSON`, and the
 * actions of its kind.
 */
function flowObject<Kind extends FlowKind, Actions extends object>(
  attempt: Attempt,
  actions: Actions
): Flow<Kind> & Actions {
  const flow = { ...actions, toJSON: () => attempt.snapshot<Kind>() }
  for (const key of ['id', 'kind', 'step', 'expiresAt'] as const) {
    Object.defineProperty(flow, key, { enumerable: true, get: () => attempt.snapshot<Kind>()[key] })
  }
  return Object.freeze(flow) as Flow<Kind> & Actions
}

/**
 * Wrap a started sign-up attempt.
 *
 * @param context - Transport, session and messages.
 * @param started - The attempt as the start call returned it.
 * @returns The flow object.
 */
export async function signUpFlow(context: FlowContext, started: FlowAttempt): Promise<SignUpFlow> {
  const { transport } = context
  const attempt = createAttempt(context, started)
  await attempt.accept(started)
  return flowObject<'sign_up', Omit<SignUpFlow, keyof FlowSnapshot | 'toJSON'>>(attempt, {
    verifyEmail: ({ code }) =>
      attempt.step((bound) => transport.call('verifySignUpEmail', { ...bound, body: { code } })),
    resendCode: () => attempt.step((bound) => transport.call('resendSignUpCode', bound)),
  })
}

/**
 * Wrap a started sign-in attempt.
 *
 * @param context - Transport, session and messages.
 * @param started - The attempt as the start call returned it.
 * @returns The flow object.
 */
export async function signInFlow(context: FlowContext, started: FlowAttempt): Promise<SignInFlow> {
  const { transport } = context
  const attempt = createAttempt(context, started)
  await attempt.accept(started)
  return flowObject<'sign_in', Omit<SignInFlow, keyof FlowSnapshot | 'toJSON'>>(attempt, {
    submitPassword: ({ password }) =>
      attempt.step((bound) =>
        transport.call('submitSignInPassword', { ...bound, body: { password } })
      ),
    verifyEmail: ({ code }) =>
      attempt.step((bound) => transport.call('verifySignInEmail', { ...bound, body: { code } })),
    resendCode: () => attempt.step((bound) => transport.call('resendSignInCode', bound)),
  })
}

/**
 * Wrap a started password-reset attempt.
 *
 * @param context - Transport, session and messages.
 * @param started - The attempt as the start call returned it.
 * @returns The flow object.
 */
export async function passwordResetFlow(
  context: FlowContext,
  started: FlowAttempt
): Promise<PasswordResetFlow> {
  const { transport } = context
  const attempt = createAttempt(context, started)
  await attempt.accept(started)
  return flowObject<'password_reset', Omit<PasswordResetFlow, keyof FlowSnapshot | 'toJSON'>>(
    attempt,
    {
      submit: ({ code, password }) =>
        attempt.step((bound) =>
          transport.call('submitPasswordReset', { ...bound, body: { code, password } })
        ),
      resendCode: () => attempt.step((bound) => transport.call('resendPasswordResetCode', bound)),
    }
  )
}
