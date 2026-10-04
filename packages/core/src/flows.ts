import {
  EMAIL_LINK_POLL_INTERVAL_MS,
  isLinkAccepted,
  type LinkStore,
  openLinkChannel,
} from './email-link'
import type { Environment } from './environment'
import { clientError, formatMessage, isTulaError, type Messages, TulaError } from './errors'
import type { Schemas } from './generated/api.gen'
import { isCodes, isTotpEnrolment } from './mfa'
import { isSessionTokens, type SessionManager } from './session'
import type { Transport } from './transport'
import type { FlowKind, FlowStep, SecondFactorProof, TotpEnrolment } from './types'

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
 * What submitting a second factor answers with.
 *
 * @example
 * ```ts
 * const { step, backupCodesRemaining } = await flow.submitSecondFactor({ method: 'backup_code', code })
 * if (backupCodesRemaining !== undefined && backupCodesRemaining < 3) {
 *   suggestNewBackupCodes()
 * }
 * ```
 */
export interface SecondFactorResult {
  /** The next step: `complete` when the proof was right. */
  readonly step: FlowStep
  /** After a backup code: how many unused ones the user has left. Absent otherwise. */
  readonly backupCodesRemaining?: number
}

/**
 * What confirming an authenticator inside a flow answers with. `backupCodes` are handed over
 * here, once: the flow object and the client keep no copy, and the server cannot show them
 * again.
 *
 * @example
 * ```ts
 * const { step, backupCodes } = await flow.confirmTotpEnrolment({ code })
 * showOnce(backupCodes)
 * ```
 */
export interface FactorEnrolmentResult {
  /** The next step: `complete`. The client is signed in. */
  readonly step: FlowStep
  /** The user's ten backup codes. Shown once. */
  readonly backupCodes: string[]
  /**
   * Set when the flow completed and the client is signed in, but the session could not be
   * saved on this device (`storage.failed`). It is reported here rather than thrown because
   * throwing would lose the backup codes.
   */
  readonly failure?: TulaError
}

/** The actions of a flow that can stop at `needs_factor_enrolment`: all three kinds. */
interface FactorEnrolmentActions {
  /**
   * Start enrolling an authenticator app (step `needs_factor_enrolment`: the environment
   * requires two-step verification and the user has none). Calling it again replaces the
   * pending secret. The step does not change.
   *
   * @returns The secret and its `otpauth://` URI, once. The flow keeps neither.
   * @throws TulaError `flow.invalid_step` on any other step.
   */
  startTotpEnrolment(): Promise<TotpEnrolment>
  /**
   * Confirm the authenticator with the 6-digit code it shows now. Completes the flow and signs
   * the client in.
   *
   * @param input - The code.
   * @returns The `complete` step and the user's backup codes, once.
   * @throws TulaError `mfa.invalid_code` for a wrong code, `mfa.enrolment_expired` when nothing
   *   was started or it was started more than ten minutes ago, `rate_limited` after repeated
   *   wrong codes.
   */
  confirmTotpEnrolment(input: { code: string }): Promise<FactorEnrolmentResult>
}

/** The action of a flow that can stop at `needs_second_factor`: sign-in and password reset. */
interface SecondFactorActions {
  /**
   * Prove a second factor (step `needs_second_factor`): the 6-digit code an authenticator app
   * shows now, or an unused backup code (spent by this call). Completes the flow.
   *
   * @param input - One of the step's `options`, and its code.
   * @returns The next step and, after a backup code, how many are left.
   * @throws TulaError `mfa.invalid_code` for a wrong (or already used) code, and
   *   `rate_limited` (with `retryAfterMs`) after repeated wrong codes.
   */
  submitSecondFactor(input: SecondFactorProof): Promise<SecondFactorResult>
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
export interface SignUpFlow extends Flow<'sign_up'>, FactorEnrolmentActions {
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
 * A user with two-step verification stops at `needs_second_factor` (answer it with
 * `submitSecondFactor`); where the environment requires it and the user has none, at
 * `needs_factor_enrolment` (`startTotpEnrolment`, then `confirmTotpEnrolment`).
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
 *
 * @example
 * ```ts
 * // An environment that offers an emailed code:
 * const flow = await tula.signIn.start({ identifier: email })
 * if (flow.step.status === 'needs_first_factor' && flow.step.strategies.includes('email_code')) {
 *   await flow.prepareFirstFactor({ strategy: 'email_code' })
 *   await flow.attemptFirstFactor({ strategy: 'email_code', code: '123456' })
 * }
 * ```
 *
 * @example
 * ```ts
 * // A user with two-step verification:
 * if (flow.step.status === 'needs_second_factor') {
 *   const { step } = await flow.submitSecondFactor({ method: 'totp', code: '123456' })
 * }
 * ```
 */
export interface SignInFlow extends Flow<'sign_in'>, FactorEnrolmentActions, SecondFactorActions {
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
  /**
   * Ask for the email that proves an email first factor (step `needs_first_factor` offering
   * `email_code` or `email_link`). The answer is the same whether or not the address has an
   * account. Calling it again sends a fresh email, at most one a minute.
   *
   * With `email_link` the email also carries a link to `redirectUrl`, which must be one of the
   * environment's allowed redirect URLs, exactly, **and on the same origin as the page that
   * asks** (scheme, host and port): what ties the link to this browser is kept in this origin's
   * storage, and a page on another origin could not read it. The link works only in this browser: the
   * flow keeps what ties the two together (in `localStorage`; it is not a token and authorizes
   * nothing by itself). Follow it with {@link SignInFlow.waitForEmailLink}.
   *
   * @param input - The strategy, and for a link the page it leads to.
   * @returns The step, still `needs_first_factor`, now with `prepared`.
   * @throws TulaError `request.redirect_not_allowed` for a URL that is not allowed,
   *   `rate_limited` (with `retryAfterMs`) when asked too soon, and two raised by the client
   *   itself, with `status: 0` and no request sent: `link.cross_origin` for a `redirectUrl` on
   *   another origin than the page (checked only where there is a page), and `storage.failed`
   *   for `email_link` in a browser without usable storage.
   */
  prepareFirstFactor(
    input: { strategy: 'email_code' } | { strategy: 'email_link'; redirectUrl: string }
  ): Promise<FlowStep>
  /**
   * Prove an email first factor: submit the emailed code, or (`email_link`) ask once whether
   * the emailed link has been opened in this browser.
   *
   * @param input - The strategy, and the code for `email_code`.
   * @returns The next step. For a link not opened yet: the unchanged `needs_first_factor`.
   * @throws TulaError `verification.invalid_code`, `verification.expired`,
   *   `verification.too_many_attempts`, or `rate_limited` while the address is locked.
   */
  attemptFirstFactor(
    input: { strategy: 'email_code'; code: string } | { strategy: 'email_link' }
  ): Promise<FlowStep>
  /**
   * Wait for the emailed link to be opened in this browser, then finish the sign-in here.
   *
   * Asks the server every few seconds (sooner when the tab that opened the link says so), until
   * the step moves on, the attempt expires, `signal` aborts, the client signs out or
   * {@link SignInFlow.discard} is called. Nothing keeps running after it settles. While it
   * waits the other actions still work (the code from the same email, a password).
   *
   * @param options - `signal`: stop waiting.
   * @returns The next step: `complete`, or `needs_second_factor`. When the wait was stopped:
   *   the step as it stands.
   * @throws TulaError `flow.not_found` once the attempt has expired, or whatever else the
   *   server refuses with.
   */
  waitForEmailLink(options?: { signal?: AbortSignal }): Promise<FlowStep>
  /**
   * Leave this sign-in: stop waiting for a link and forget what the flow kept for it in the
   * browser. Call it when the user goes back or the screen is closed.
   */
  discard(): void
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
export interface PasswordResetFlow
  extends Flow<'password_reset'>,
    FactorEnrolmentActions,
    SecondFactorActions {
  /**
   * Submit the emailed code and the new password (step `needs_new_password`).
   *
   * @param input - The code and the new password.
   * @returns The next step: `complete`, or `needs_second_factor` for a user who has one
   *   (answer it with `submitSecondFactor`).
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
  /** The runtime: timers and the channel to other tabs. */
  environment: Environment
  /** Where an emailed link's binding is kept until the link is opened. */
  links: LinkStore
  /** Names the API and environment (the link channel's name). */
  scope: string
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
    if (next.linkBinding) {
      // Kept for the tab the emailed link will open in. Not the secret: see `LinkStore`.
      context.links.save(next.id, next.linkBinding)
    }
    if (next.step.status === 'complete') {
      // A completed attempt accepts nothing more, so its secret has no further use, and
      // neither has a link's binding.
      secret = null
      context.links.remove(next.id)
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

  /**
   * Run one action on this attempt, alone.
   *
   * Two things are refused here, without a request, because the client knows the answer and a
   * request could only do harm: an action on a completed flow (`flow.invalid_step`, the code
   * the server uses for the same thing), and a second action while one is still being sent
   * (`flow.busy`: a double-clicked button would otherwise spend two guesses, or send two
   * emails).
   *
   * @param action - Makes the call, given the attempt's id and secret, and reads its answer.
   * @returns What the action returns.
   * @throws TulaError `flow.invalid_step` or `flow.busy`, both with `status: 0`.
   */
  async function exclusive<T>(action: (binding: Binding) => Promise<T>): Promise<T> {
    if (secret === null) {
      throw refused('flow.invalid_step')
    }
    if (busy) {
      throw refused('flow.busy')
    }
    busy = true
    try {
      // An action can complete the flow and set the session (and, in a browser, its cookie).
      // It must not overlap a refresh of the session it replaces.
      await context.session.idle()
      return await action({ params: { attemptId: current.id }, attemptSecret: secret })
    } finally {
      busy = false
    }
  }

  return {
    snapshot: <Kind extends FlowKind>(): FlowSnapshot<Kind> => current as FlowSnapshot<Kind>,
    accept,
    refused,
    /** Whether an action is being sent right now. */
    busy: () => busy,
    /** Whether the flow has completed. */
    finished: () => secret === null,
    exclusive,
    /**
     * Send one call on this attempt and take the server's answer as the new step.
     *
     * @param send - Makes the call, given the attempt's id and secret.
     * @returns The next step.
     * @throws TulaError `flow.invalid_step` or `flow.busy`, both with `status: 0`.
     */
    step: (send: (binding: Binding) => Promise<FlowAttempt>): Promise<FlowStep> =>
      exclusive(async (bound) => accept(await send(bound))),
  }
}

type Attempt = ReturnType<typeof createAttempt>

/** The in-flow enrolment operations of each kind of flow: start, then confirm. */
const ENROLMENT = {
  sign_up: ['startSignUpTotpEnrolment', 'confirmSignUpTotpEnrolment'],
  sign_in: ['startSignInTotpEnrolment', 'confirmSignInTotpEnrolment'],
  password_reset: ['startPasswordResetTotpEnrolment', 'confirmPasswordResetTotpEnrolment'],
} as const

/**
 * The actions that enrol an authenticator inside an attempt.
 *
 * The secret, its URI and the backup codes pass through to the caller. Nothing here, on the
 * attempt or on the flow object keeps them: they are shown once and cannot be fetched again.
 */
function enrolmentActions(
  context: FlowContext,
  attempt: Attempt,
  kind: FlowKind
): FactorEnrolmentActions {
  const [start, confirm] = ENROLMENT[kind]
  return {
    startTotpEnrolment: () =>
      attempt.exclusive(async (bound) => {
        const enrolment: unknown = await context.transport.call(start, bound)
        if (!isTotpEnrolment(enrolment)) {
          throw clientError('response.invalid', context.messages())
        }
        return { secret: enrolment.secret, uri: enrolment.uri }
      }),
    confirmTotpEnrolment: ({ code }) =>
      attempt.exclusive(async (bound) => {
        const next = await context.transport.call(confirm, { ...bound, body: { code } })
        const backupCodes: unknown = isRecord(next) ? next.backupCodes : undefined
        // Checked before the attempt is accepted: an answer without the codes is not this
        // API's, and must not sign anybody in.
        if (!isCodes(backupCodes)) {
          throw clientError('response.invalid', context.messages())
        }
        try {
          return { step: await attempt.accept(next), backupCodes }
        } catch (error) {
          if (!attempt.finished() || !isTulaError(error)) {
            throw error
          }
          // The flow completed and the session is in memory; only saving it failed. The codes
          // exist nowhere else, so the failure travels with them instead of replacing them.
          return { step: attempt.snapshot().step, backupCodes, failure: error }
        }
      }),
  }
}

/** The action that proves a second factor on an attempt. */
function secondFactorAction(
  context: FlowContext,
  attempt: Attempt,
  operation: 'submitSignInSecondFactor' | 'submitPasswordResetSecondFactor'
): SecondFactorActions['submitSecondFactor'] {
  return ({ method, code }) =>
    attempt.exclusive(async (bound) => {
      const next = await context.transport.call(operation, { ...bound, body: { method, code } })
      const remaining: unknown = isRecord(next) ? next.backupCodesRemaining : undefined
      if (remaining !== undefined && !(Number.isInteger(remaining) && Number(remaining) >= 0)) {
        throw clientError('response.invalid', context.messages())
      }
      const step = await attempt.accept(next)
      return remaining === undefined ? { step } : { step, backupCodesRemaining: Number(remaining) }
    })
}

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
    ...enrolmentActions(context, attempt, 'sign_up'),
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
  const waiting = emailLinkWait(context, attempt)
  return flowObject<'sign_in', Omit<SignInFlow, keyof FlowSnapshot | 'toJSON'>>(attempt, {
    submitPassword: ({ password }) =>
      attempt.step((bound) =>
        transport.call('submitSignInPassword', { ...bound, body: { password } })
      ),
    verifyEmail: ({ code }) =>
      attempt.step((bound) => transport.call('verifySignInEmail', { ...bound, body: { code } })),
    resendCode: () => attempt.step((bound) => transport.call('resendSignInCode', bound)),
    submitSecondFactor: secondFactorAction(context, attempt, 'submitSignInSecondFactor'),
    ...enrolmentActions(context, attempt, 'sign_in'),
    async prepareFirstFactor(input) {
      if (input.strategy === 'email_link' && !context.links.available()) {
        // Without somewhere to keep the binding the link could never be honoured: say so
        // before an email is sent that would only disappoint.
        throw clientError('storage.failed', context.messages())
      }
      if (input.strategy === 'email_link' && leavesOrigin(context, input.redirectUrl)) {
        // Storage belongs to an origin: a page elsewhere could not read the binding, and the
        // link would answer "different browser" in the very browser that asked.
        throw clientError('link.cross_origin', context.messages())
      }
      return attempt.step((bound) =>
        transport.call('prepareSignInFirstFactor', { ...bound, body: input })
      )
    },
    attemptFirstFactor: (input) =>
      attempt.step((bound) =>
        transport.call('attemptSignInFirstFactor', { ...bound, body: input })
      ),
    waitForEmailLink: (options) => waiting.wait(options?.signal),
    discard() {
      waiting.stop()
      context.links.remove(attempt.snapshot().id)
    },
  })
}

/**
 * Whether `redirectUrl` is on another origin than the page the client runs in. `false` when
 * there is no page (not a browser) or either URL cannot be read: the server then decides.
 */
function leavesOrigin(context: FlowContext, redirectUrl: string): boolean {
  const page = context.environment.page
  if (!page) {
    return false
  }
  try {
    return new URL(redirectUrl).origin !== new URL(page.url()).origin
  } catch {
    return false
  }
}

/**
 * The waiting side of an emailed link: the tab that started the sign-in asks the server
 * whether the link has been opened, and completes the sign-in when it has.
 *
 * One loop per flow, shared by every caller; each caller leaves with its own signal, and the
 * loop goes on while anyone is left. That matters because a UI stops and restarts its wait in
 * one tick (an effect cleaned up and set up again): the restart must not end with the signal
 * of the wait it replaces. Each round is one timer; the timer is cancelled, the channel closed
 * and the listeners removed before the loop ends, so nothing is left running. A `rate_limited`
 * answer is obeyed (the next round waits `retryAfterMs`), a round with no answer at all is
 * simply tried again, and anything else ends the wait, for every caller, with that error.
 */
function emailLinkWait(context: FlowContext, attempt: Attempt) {
  const { environment, transport, session } = context
  let loop: Promise<FlowStep> | null = null
  /** Lets each caller that is still waiting go, with the step as it stands. */
  const callers = new Set<() => void>()
  /** Nobody is waiting any more: the loop ends at its next turn. */
  let stopping = false
  /** A caller arrived while the loop was about to stop: it sleeps again instead of asking. */
  let resumed = false
  let wake: (() => void) | null = null

  function stop(): void {
    for (const release of [...callers]) {
      release()
    }
    if (loop) {
      stopping = true
      wake?.()
    }
  }

  async function run(): Promise<FlowStep> {
    const channel = openLinkChannel(environment, context.scope)
    if (channel) {
      channel.onmessage = (event) => {
        if (isLinkAccepted(event.data, attempt.snapshot().id)) {
          wake?.()
        }
      }
    }
    const stopListening = session.subscribe((state) => {
      if (state.status === 'signed-out') {
        stop()
      }
    })
    let delay = EMAIL_LINK_POLL_INTERVAL_MS
    try {
      for (;;) {
        if (!stopping) {
          let cancel: () => void = () => undefined
          await new Promise<void>((resolve) => {
            wake = resolve
            cancel = environment.setTimer(resolve, delay)
          })
          wake = null
          cancel()
        }
        if (resumed) {
          resumed = false
          continue
        }
        delay = EMAIL_LINK_POLL_INTERVAL_MS
        const { step } = attempt.snapshot()
        if (stopping || attempt.finished() || step.status !== 'needs_first_factor') {
          return step
        }
        if (attempt.busy()) {
          // The user is submitting something else (the code, a password). Try the next round.
          continue
        }
        try {
          const next = await attempt.step((bound) =>
            transport.call('attemptSignInFirstFactor', {
              ...bound,
              body: { strategy: 'email_link' },
            })
          )
          if (next.status !== 'needs_first_factor') {
            return next
          }
        } catch (error) {
          if (!isTulaError(error)) {
            throw error
          }
          if (error.code === 'rate_limited') {
            delay = Math.max(delay, error.retryAfterMs ?? 0)
          } else if (
            error.code !== 'network.failed' &&
            error.code !== 'network.timeout' &&
            error.code !== 'flow.busy'
          ) {
            throw error
          }
        }
      }
    } finally {
      // Cleared here, in the loop's last synchronous step, so that a caller arriving right
      // after starts a new loop instead of joining one that has ended.
      loop = null
      stopping = false
      resumed = false
      wake = null
      stopListening()
      if (channel) {
        channel.onmessage = null
        channel.close?.()
      }
    }
  }

  return {
    wait(signal: AbortSignal | undefined): Promise<FlowStep> {
      if (attempt.finished()) {
        return Promise.reject(attempt.refused('flow.invalid_step'))
      }
      if (signal?.aborted) {
        return Promise.resolve(attempt.snapshot().step)
      }
      if (stopping) {
        // The loop was about to end for want of callers. Here is one.
        stopping = false
        resumed = true
      }
      loop ??= run()
      const running = loop
      return new Promise<FlowStep>((resolve, reject) => {
        const leave = () => {
          callers.delete(release)
          signal?.removeEventListener('abort', release)
        }
        const release = () => {
          leave()
          resolve(attempt.snapshot().step)
          if (callers.size === 0) {
            stopping = true
            wake?.()
          }
        }
        callers.add(release)
        signal?.addEventListener('abort', release)
        running.then(
          (step) => {
            leave()
            resolve(step)
          },
          (error) => {
            leave()
            reject(error)
          }
        )
      })
    },
    stop,
  }
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
      submitSecondFactor: secondFactorAction(context, attempt, 'submitPasswordResetSecondFactor'),
      ...enrolmentActions(context, attempt, 'password_reset'),
    }
  )
}
