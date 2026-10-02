import type { FlowKind, FlowStatus } from '@tula/contract'
import { AuthError } from '~/exceptions'

/** Something a client proved, which may move an attempt to its next step. */
export type FlowEvent =
  | { type: 'password_verified'; emailVerified: boolean }
  | { type: 'email_verified' }

/**
 * The step an attempt moves to after an event. Pure, so every path is table-tested.
 *
 * This is the whole state machine for Phase 0:
 *
 * - `sign_up`: `needs_email_verification` → `complete`.
 * - `sign_in`: `needs_password` → `complete`, or → `needs_email_verification` → `complete` when
 *   the user's email is not verified yet.
 *
 * Adding a sign-in method means adding a step here, not logic in each SDK.
 *
 * @param kind - Sign-in or sign-up.
 * @param status - The step the attempt is waiting on.
 * @param event - What the client just proved.
 * @returns The next step.
 * @throws AuthError `flow.invalid_step` when the event is not valid at this step.
 */
export function nextStatus(kind: FlowKind, status: FlowStatus, event: FlowEvent): FlowStatus {
  if (status === 'needs_email_verification' && event.type === 'email_verified') {
    return 'complete'
  }
  if (kind === 'sign_in' && status === 'needs_password' && event.type === 'password_verified') {
    return event.emailVerified ? 'complete' : 'needs_email_verification'
  }
  throw new AuthError('flow.invalid_step')
}
