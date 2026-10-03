import type { FirstFactorStrategy, FlowKind, FlowStatus, SecondFactorMethod } from '@tula/contract'
import { AuthError } from '~/exceptions'

/** Every kind of event, so a test can enumerate them. */
export const FLOW_EVENT_TYPES = [
  'first_factor_verified',
  'email_verified',
  'password_reset',
  'second_factor_verified',
] as const

/** The kind of a {@link FlowEvent}. */
export type FlowEventType = (typeof FLOW_EVENT_TYPES)[number]

/** Something a client proved, which may move an attempt to its next step. */
export type FlowEvent =
  | { type: 'first_factor_verified'; strategy: FirstFactorStrategy }
  | { type: 'email_verified' }
  | { type: 'password_reset' }
  | { type: 'second_factor_verified' }

/** What the next step depends on besides the attempt's kind, its step and the event. */
export interface FlowContext {
  /** The first factors the attempt was offered when it started (from the environment's settings). */
  strategies: readonly FirstFactorStrategy[]
  /** Whether the user's email is verified, counting what this event itself proved. */
  emailVerified: boolean
  /** The second factors the user must prove one of. Empty when none is required. */
  secondFactors: readonly SecondFactorMethod[]
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
 * - `sign_up`: `needs_email_verification` → `complete`. (The account is created at that moment,
 *   so it has no second factor yet.)
 * - `sign_in`: `needs_password` or `needs_first_factor` → (`needs_email_verification` when the
 *   user's email is not verified) → (`needs_second_factor` when the user has one) → `complete`.
 *   A first factor is accepted on `needs_password` only if it is the password, and on
 *   `needs_first_factor` only if it is one of the strategies the attempt was offered.
 * - `password_reset`: `needs_new_password` → (`needs_second_factor`) → `complete`. An inbox
 *   alone never bypasses a second factor.
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
  const afterFactors = context.secondFactors.length > 0 ? 'needs_second_factor' : 'complete'
  if (event.type === 'first_factor_verified') {
    if (kind === 'sign_in' && offers(status, event.strategy, context)) {
      return context.emailVerified ? afterFactors : 'needs_email_verification'
    }
  } else if (event.type === 'email_verified') {
    if (kind === 'sign_up' && status === 'needs_email_verification') {
      return 'complete'
    }
    if (kind === 'sign_in' && status === 'needs_email_verification') {
      return afterFactors
    }
  } else if (event.type === 'password_reset') {
    if (kind === 'password_reset' && status === 'needs_new_password') {
      return afterFactors
    }
  } else if (kind !== 'sign_up' && status === 'needs_second_factor') {
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
  nextStatus(kind, status, event, { strategies, emailVerified: false, secondFactors: [] })
}
