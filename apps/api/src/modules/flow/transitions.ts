import type { FirstFactorStrategy, FlowKind, FlowStatus, SecondFactorMethod } from '@tula/contract'
import { AuthError } from '~/exceptions'

/** Every kind of event, so a test can enumerate them. */
export const FLOW_EVENT_TYPES = [
  'first_factor_verified',
  'email_verified',
  'password_reset',
  'second_factor_verified',
  'factor_enrolled',
  'expired_password_replaced',
] as const

/** The kind of a {@link FlowEvent}. */
export type FlowEventType = (typeof FLOW_EVENT_TYPES)[number]

/** Something a client proved, which may move an attempt to its next step. */
export type FlowEvent =
  | { type: 'first_factor_verified'; strategy: FirstFactorStrategy }
  | { type: 'email_verified' }
  | { type: 'password_reset' }
  | { type: 'second_factor_verified' }
  | { type: 'factor_enrolled' }
  | { type: 'expired_password_replaced' }

/** What the next step depends on besides the attempt's kind, its step and the event. */
export interface FlowContext {
  /** The first factors the attempt was offered when it started (from the environment's settings). */
  strategies: readonly FirstFactorStrategy[]
  /** Whether the user's email is verified, counting what this event itself proved. */
  emailVerified: boolean
  /** The second factors the user must prove one of. Empty when none is required. */
  secondFactors: readonly SecondFactorMethod[]
  /**
   * The environment requires a second factor and the user has none: they must enrol one before
   * the attempt completes. Never true together with a non-empty `secondFactors`.
   */
  enrolmentRequired: boolean
  /**
   * The attempt is a sign-in that proved a password older than the environment's
   * `password.expiryDays` allows (ADR 0041): it must set a new one before it completes. Only
   * a sign-in **with the password** is ever held to it: for another first factor, and for a
   * sign-up or a reset, it changes nothing.
   */
  passwordExpired: boolean
}

/** Whether an attempt on `status` accepts a first factor proven with `strategy`. */
function offers(
  status: FlowStatus,
  strategy: FirstFactorStrategy,
  context: Pick<FlowContext, 'strategies'>
): boolean {
  if (status === 'needs_password') {
    return strategy === 'password'
  }
  return status === 'needs_first_factor' && context.strategies.includes(strategy)
}

/**
 * The step an attempt moves to after an event. Pure, so every path is table-tested: the test
 * enumerates every kind × step × event and asserts each one allowed or refused.
 *
 * This is the whole state machine:
 *
 * - `sign_up`: `needs_email_verification` → (`needs_factor_enrolment`) → `complete`. (The
 *   account is created when the email is verified, so it has no second factor to ask for.)
 * - `sign_in`: `needs_password` or `needs_first_factor` → (`needs_email_verification` when the
 *   user's email is not verified) → (`needs_second_factor` when the user has one, or
 *   `needs_factor_enrolment` when the environment requires one and they have none) →
 *   (`needs_new_password` when the password that was proven has expired) → `complete`. A
 *   first factor is accepted on `needs_password` only if it is the password, and on
 *   `needs_first_factor` only if it is one of the strategies the attempt was offered.
 *   **An expired password comes last**, after the second factor or the enrolment: whoever
 *   holds only an old password must not get to replace the password of an account that has
 *   a second factor (ADR 0041).
 * - `password_reset`: `needs_new_password` → (`needs_second_factor` or
 *   `needs_factor_enrolment`) → `complete`. An inbox alone never bypasses a second factor.
 *
 * Nothing leads from `needs_second_factor` to `needs_factor_enrolment` or back: a user either
 * has a factor to prove or has one to enrol. Nothing leads back from `needs_new_password`
 * either, and on a sign-in only a replaced password leaves it.
 *
 * Adding a sign-in method does not change this function: a new first factor is one more
 * `strategy` (registered in `~/modules/factor/service`), a new second factor one more option.
 *
 * @param kind - Sign-in, sign-up or password reset.
 * @param status - The step the attempt is waiting on.
 * @param event - What the client just proved.
 * @param context - The offered strategies, and what is known about the user.
 * @returns The next step.
 * @throws AuthError `flow.invalid_step` when the event is not valid at this step.
 */
export function nextStatus(
  kind: FlowKind,
  status: FlowStatus,
  event: FlowEvent,
  context: FlowContext
): FlowStatus {
  // What a sign-in still owes once its factors are proven: a new password, if the one it
  // proved has expired. A password event carries its own strategy; every later event of a
  // sign-in is told by the caller, who kept what the attempt proved.
  const renewOrComplete =
    kind === 'sign_in' && context.passwordExpired ? 'needs_new_password' : 'complete'
  const enrolOr = (last: FlowStatus) =>
    context.enrolmentRequired ? 'needs_factor_enrolment' : last
  const afterFactors = (last: FlowStatus) =>
    context.secondFactors.length > 0 ? 'needs_second_factor' : enrolOr(last)
  if (event.type === 'first_factor_verified') {
    if (kind === 'sign_in' && offers(status, event.strategy, context)) {
      // Only the password can be too old: another first factor never stops for it.
      const last = event.strategy === 'password' ? renewOrComplete : 'complete'
      return context.emailVerified ? afterFactors(last) : 'needs_email_verification'
    }
  } else if (event.type === 'email_verified') {
    if (kind === 'sign_up' && status === 'needs_email_verification') {
      // The account is created by this event: it cannot have a factor yet, only need one.
      return enrolOr('complete')
    }
    if (kind === 'sign_in' && status === 'needs_email_verification') {
      return afterFactors(renewOrComplete)
    }
  } else if (event.type === 'password_reset') {
    if (kind === 'password_reset' && status === 'needs_new_password') {
      return afterFactors('complete')
    }
  } else if (event.type === 'second_factor_verified') {
    if (kind !== 'sign_up' && status === 'needs_second_factor') {
      return renewOrComplete
    }
  } else if (event.type === 'factor_enrolled') {
    if (status === 'needs_factor_enrolment') {
      return renewOrComplete
    }
  } else if (kind === 'sign_in' && status === 'needs_new_password') {
    return 'complete'
  }
  throw new AuthError('flow.invalid_step')
}

/**
 * Refuse an event that is not valid at an attempt's step, before any work is done for it.
 *
 * Asks {@link nextStatus}, so the table stays the only place that decides. Whether an event is
 * *accepted* never depends on the user (only where it leads does), so this needs no user.
 *
 * @param kind - Sign-in, sign-up or password reset.
 * @param status - The step the attempt is waiting on.
 * @param event - What the client is about to prove.
 * @param strategies - The first factors the attempt was offered.
 * @throws AuthError `flow.invalid_step` when the event is not valid at this step.
 */
export function assertAccepts(
  kind: FlowKind,
  status: FlowStatus,
  event: FlowEvent,
  strategies: readonly FirstFactorStrategy[] = []
): void {
  nextStatus(kind, status, event, {
    strategies,
    emailVerified: false,
    secondFactors: [],
    enrolmentRequired: false,
    passwordExpired: false,
  })
}
